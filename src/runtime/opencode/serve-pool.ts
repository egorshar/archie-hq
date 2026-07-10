/**
 * Per-agent-instance opencode serve pool (P3a §1/§5). Each spawned Agent gets
 * its own `opencode serve` child, keyed `${taskId}:${agentId}`: cwd staged with
 * only that agent's skills, config.model = that agent's route, a bridge token
 * unique to it, and its own SSE consumer. Children boot on demand, are recycled
 * at turn boundaries when stale (plugins push / mode transition), reaped when
 * their agent idles past OPENCODE_CHILD_IDLE_TTL, and evicted (+ synthetic
 * roots rm'd) at task teardown. Sessions persist in opencode's process-global
 * store (spike S1=RESUME), so recycle/reap are context-free.
 *
 * Serve-root ownership: the pool owns only SYNTHETIC roots (clone-less PM /
 * plugin agents) and rm's them ONLY in evictTask — child close/reap always
 * keeps the root so a respawned child reuses its staged dir. Repo-agent skill
 * dirs live under the clone and are cleaned with the clone.
 */
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { logger } from '../../system/logger.js';
import { WORKDIR } from '../../system/workdir.js';
import {
  startEmbeddedServer, prepareServeRoot, SERVE_PERMISSION, type OpencodeClient,
} from './embedded-server.js';
import { getBridge, sharedRegistry } from './server.js';
import { writeBridgePlugin } from './bridge/plugin-source.js';
import { stageAgentSkills, excludeOpencodeFromGit } from './skills.js';
import { buildOpencodeMcpConfig } from './mcp-config.js';
import { resolveAgentOpencodeModel } from './model.js';
import { startEventConsumer } from './events.js';

export type StaleReason = 'plugins' | 'mode-transition';

export interface ServeHandle {
  client: OpencodeClient;
  url: string;
  /** This child's bridge bearer token (A4). Revoked on close. Never log it. */
  token: string;
  /** The serve cwd this child booted with — compared on re-acquire so a clone
   * re-created at a new path (RO→RW) recycles the child (mode-transition). */
  cwd: string;
  markStale(reason: StaleReason): void;
  isStale(): boolean;
  isClosed(): boolean;
  /** Kill the serve child, stop its SSE consumer, revoke its token, evict it
   * from the pool. LEAVES the serve root on disk (evictTask rm's it). */
  close(): Promise<void>;
}

/** How to place the child's cwd: a repo agent's clone, else a synthetic root. */
export interface AgentServeSpec { clonePath?: string }

interface PoolEntry {
  promise: Promise<ServeHandle>;
  handle: ServeHandle | null; // set when the boot resolves; null while booting
}

const pool = new Map<string, PoolEntry>();
let shuttingDown = false;

const poolKey = (taskId: string, agentId: string): string => `${taskId}:${agentId}`;
const taskServeRoot = (taskId: string): string => join(WORKDIR, 'opencode-server', taskId);
const syntheticRoot = (taskId: string, agentId: string): string => join(taskServeRoot(taskId), agentId);

/** Parse `15m` / `30s` / `2h` / bare-ms. Invalid → null (caller applies default). */
function parseDurationMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  return n * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1);
}

/** OPENCODE_CHILD_IDLE_TTL — how long an agent may park on nextMessage() before
 * its child is reaped. 15m default is safe: reap is context-free (S1=RESUME). */
export function childIdleTtlMs(): number {
  return parseDurationMs(process.env.OPENCODE_CHILD_IDLE_TTL) ?? 15 * 60_000;
}

/** OPENCODE_CHILD_SOFT_CAP — census-warn threshold. Telemetry only in P3a:
 * never queues or blocks a spawn. */
export function childSoftCap(): number {
  const n = Number(process.env.OPENCODE_CHILD_SOFT_CAP);
  return Number.isInteger(n) && n > 0 ? n : 12;
}

export function liveChildCount(): number {
  let n = 0;
  for (const entry of pool.values()) if (entry.handle && !entry.handle.isClosed()) n++;
  return n;
}

/**
 * Acquire the agent's serve child: reuse a live warm handle, recycle a stale
 * one (plugins push) or one whose world moved (cwd change = mode transition),
 * boot on demand otherwise. Idempotent per key — concurrent callers for the
 * same agent await one boot. Boot failure rejects; the runtime routes it into
 * task recovery.
 */
export async function getAgentServe(agent: Agent, task: Task, spec: AgentServeSpec = {}): Promise<ServeHandle> {
  const key = poolKey(task.taskId, agent.def.id);
  const desiredCwd = spec.clonePath ?? syntheticRoot(task.taskId, agent.def.id);

  const existing = pool.get(key);
  if (existing) {
    const handle = await existing.promise.catch(() => null); // a failed boot was already evicted
    if (handle && !handle.isClosed()) {
      if (handle.cwd !== desiredCwd) {
        // RO→RW: the clone was re-created at a NEW path while the pool key
        // stayed constant — the child's world changed under a warm handle.
        // This is also the future P3b remount point.
        handle.markStale('mode-transition');
      }
      if (!handle.isStale()) return handle;
      await handle.close(); // turn-boundary recycle: fresh boot below re-stages skills
    }
  }

  // A fresh boot resets the shutdown guard (same semantics as the old
  // server.ts singleton: "reset on each fresh boot so a later call re-boots
  // cleanly" after a dev-reload shutdown).
  shuttingDown = false;
  const entry: PoolEntry = { promise: undefined as unknown as Promise<ServeHandle>, handle: null };
  entry.promise = bootChild(agent, task, key, desiredCwd, spec.clonePath != null, entry);
  pool.set(key, entry);
  try {
    const handle = await entry.promise;
    entry.handle = handle;
    return handle;
  } catch (err) {
    if (pool.get(key) === entry) pool.delete(key);
    throw err;
  }
}

async function bootChild(
  agent: Agent,
  task: Task,
  key: string,
  cwd: string,
  isClone: boolean,
  entry: PoolEntry,
): Promise<ServeHandle> {
  const t0 = Date.now();
  const skillsDir = join(cwd, '.opencode', 'skills');
  const pluginsDir = join(cwd, '.opencode', 'plugins');

  // Everything a boot needs before it can call startEmbeddedServer is
  // independent I/O, merged into ONE concurrent wave (rather than several
  // sequential awaits) so a boot reaches the spawn call in as few round-trips
  // as possible — this matters for closeServePool's shutdown race: a
  // late-resolving boot must reach `startEmbeddedServer` promptly enough that
  // a concurrent teardown can still observe (and close) it. The bridge → mint
  // → writeBridgePlugin chain is the one genuine sequential dependency (the
  // plugin file must carry this child's real token and must exist before the
  // server starts, since opencode loads plugins at boot); it runs as its own
  // branch inside the wave rather than gating everything else. `bridge`/
  // `token` are captured into outer-scoped variables (not the branch's return
  // value) so a later failure — in this branch or in startEmbeddedServer —
  // can still revoke a token that was successfully minted.
  let bridge: Awaited<ReturnType<typeof getBridge>> | undefined;
  let token: string | undefined;
  try {
    const [, mcp] = await Promise.all([
      isClone ? Promise.resolve() : prepareServeRoot(cwd),
      buildOpencodeMcpConfig(),
      (async () => {
        bridge = await getBridge();
        token = bridge.mintChildToken({ taskId: task.taskId, agentId: agent.def.id });
        await writeBridgePlugin(pluginsDir, bridge.url, token);
      })(),
      (async () => {
        try {
          const n = await stageAgentSkills(agent.def, skillsDir);
          if (isClone) await excludeOpencodeFromGit(cwd);
          logger.system(`opencode[${key}]: staged ${n} skill source(s) into ${skillsDir}`);
        } catch (err) {
          logger.warn('opencode', `opencode[${key}]: skill staging failed (agent runs without skills): ${err instanceof Error ? err.message : String(err)}`);
        }
      })(),
    ]);
    // The bridge branch above either populated both `bridge`/`token` or threw
    // (which Promise.all propagates, skipping past this point into the catch).
    const liveBridge = bridge!;
    const liveToken = token!;

    // This agent's route IS the child's server-global model (P3a §6) —
    // resolveAgentOpencodeModel falls back to ARCHIE_OPENCODE_MODEL_DEFAULT
    // internally; if neither resolves the boot fails (same as the old
    // shared-server 'default' resolution) and task recovery runs.
    const model = resolveAgentOpencodeModel(agent.def);

    // Spawn. THIS is the P3b sandbox-wrap point: the per-child OS sandbox
    // (bubblewrap mounts + egress proxy) will wrap this child spawn.
    const server = await startEmbeddedServer({
      cwd,
      config: { model: `${model.providerID}/${model.modelID}`, permission: SERVE_PERMISSION, mcp },
    });
    if (shuttingDown) {
      try { server.close(); } catch { /* best-effort */ }
      liveBridge.revokeChildToken(liveToken);
      throw new Error(`opencode[${key}]: child boot aborted during shutdown`);
    }

    // Per-child SSE consumer — each child's stream carries only its own
    // sessions; routing keys off the global sharedRegistry, so N consumers
    // coexist with no cross-talk.
    const consumer = startEventConsumer(server.client, sharedRegistry);

    let stale: StaleReason | null = null;
    let closed = false;
    const handle: ServeHandle = {
      client: server.client,
      url: server.url,
      token: liveToken,
      cwd,
      markStale: (reason) => {
        if (!stale) logger.system(`opencode[${key}]: marked stale (${reason}) — recycles at the next turn boundary`);
        stale = reason;
      },
      isStale: () => stale !== null,
      isClosed: () => closed,
      close: async () => {
        if (closed) return;
        closed = true;
        consumer.stop();
        try { server.close(); } catch { /* child already gone */ }
        liveBridge.revokeChildToken(liveToken);
        if (pool.get(key) === entry) pool.delete(key);
      },
    };

    // Eager dead-handle eviction (A5): a crash removes the pool entry
    // immediately so the next getAgentServe never returns a corpse.
    server.onExit(() => {
      if (!closed) logger.warn('opencode', `opencode[${key}]: serve child exited unexpectedly — evicting; respawn on next demand`);
      void handle.close();
    });

    logger.system(`opencode[${key}]: child up in ${Date.now() - t0}ms (cwd=${cwd})`);
    const live = liveChildCount() + 1; // this handle isn't in entry.handle yet
    const cap = childSoftCap();
    if (live > cap) {
      logger.warn('opencode', `live serve children (${live}) exceed OPENCODE_CHILD_SOFT_CAP (${cap}) — census: ${[...pool.keys()].join(', ')}`);
    }
    return handle;
  } catch (err) {
    // The bridge branch may not have run to completion (or at all, if
    // Promise.all short-circuited on a different branch's rejection) — only
    // revoke a token that was actually minted.
    if (bridge && token) bridge.revokeChildToken(token);
    throw err;
  }
}

/**
 * Arm the idle-reap timer for a PARKED agent (armed by the turn loop right
 * before it awaits nextMessage(), disarmed the moment a message lands — so the
 * reap can only ever act at the parked/turn-boundary signal, never mid-turn).
 * Reaping closes the child (root kept, token revoked) and leaves the agent
 * parked; the next inbound message re-acquires a fresh child. Returns disarm.
 */
export function scheduleIdleReap(agent: Agent, task: Task): () => void {
  const key = poolKey(task.taskId, agent.def.id);
  const timer = setTimeout(() => {
    const handle = pool.get(key)?.handle;
    if (!handle || handle.isClosed()) return;
    logger.system(`opencode[${key}]: parked > ${childIdleTtlMs()}ms — reaping child (root kept; sessions resume from opencode's global store)`);
    void handle.close();
  }, childIdleTtlMs());
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Plugins push: mark every live child stale; each recycles at its next turn
 * boundary (tiny blast radius). Children still booting stage fresh skills by
 * construction. */
export function markAllServesStale(reason: StaleReason): void {
  for (const entry of pool.values()) entry.handle?.markStale(reason);
}

/** Task teardown: close any children still open for the task and rm the task's
 * synthetic serve-root dir — the ONLY place roots are removed (A5). */
export async function evictTask(taskId: string): Promise<void> {
  const prefix = `${taskId}:`;
  for (const [key, entry] of [...pool.entries()]) {
    if (!key.startsWith(prefix)) continue;
    const handle = entry.handle ?? (await entry.promise.catch(() => null));
    if (handle) await handle.close();
    pool.delete(key);
  }
  await rm(taskServeRoot(taskId), { recursive: true, force: true });
}

/** Process shutdown: close every RESOLVED child and clear the pool. Does NOT
 * await in-flight boots (a hung spawn would block shutdown); those are handled
 * by the `shuttingDown` guard in bootChild, which closes a child that finishes
 * booting after teardown began. The guard stays set until the next fresh
 * getAgentServe (dev-reload path) resets it. */
export async function closeServePool(): Promise<void> {
  shuttingDown = true;
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map(async (entry) => {
    if (entry.handle) await entry.handle.close();
  }));
}
