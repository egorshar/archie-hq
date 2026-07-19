/**
 * Per-agent-instance opencode serve pool (P3a §1/§5). Each spawned Agent gets
 * its own `opencode serve` child, keyed `${taskId}:${agentId}`: cwd staged with
 * only that agent's skills, config.model = that agent's route, a bridge token
 * unique to it, and its own SSE consumer. Children boot on demand, are recycled
 * at turn boundaries when stale (plugins push / mode transition), reaped when
 * their agent idles past OPENCODE_CHILD_IDLE_TTL, and evicted (+ synthetic
 * roots rm'd) at task teardown. Each child's opencode session store is pinned
 * to a PER-AGENT data dir under the workdir volume (P3b: HOME/XDG_DATA_HOME =
 * agentHomeDir; it is NOT opencode's process-global ~/.local/share store), so
 * resume is context-free across a child recycle/reap AND across daemon restarts
 * (the store outlives the process on the mounted volume); a resume miss (store
 * erased, or a task reopened after teardown removed its per-agent dir) falls
 * back to runPromptTurn's 404 → fresh-session recovery.
 *
 * Serve-root ownership: the pool owns only SYNTHETIC roots (clone-less PM /
 * plugin agents) and rm's them ONLY in evictTask — child close/reap always
 * keeps the root so a respawned child reuses its staged dir. Repo-agent skill
 * dirs live under the clone and are cleaned with the clone.
 */
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { logger } from '../../system/logger.js';
import { WORKDIR } from '../../system/workdir.js';
import { safePathSegment } from '../../system/path-safety.js';
import {
  startEmbeddedServer, prepareServeRoot, SERVE_PERMISSION, type OpencodeClient,
} from './embedded-server.js';
import { getBridge, sharedRegistry } from './server.js';
import { writeBridgePlugin } from './bridge/plugin-source.js';
import { stageAgentSkills, excludeOpencodeFromGit, vendorBridgeDeps } from './skills.js';
import { buildOpencodeMcpConfig } from './mcp-config.js';
import { resolveAgentOpencodeModel } from './model.js';
import { startEventConsumer } from './events.js';
import { buildChildSandboxProfile, wrapServeCommand, agentProfileFingerprint, agentHomeDir } from './child-sandbox.js';
import { getEgressProxy } from './egress-proxy.js';

export type StaleReason = 'plugins' | 'mode-transition';

export interface ServeHandle {
  client: OpencodeClient;
  url: string;
  /** This child's bridge bearer token (A4). Revoked on close. Never log it. */
  token: string;
  /** The serve cwd this child booted with. */
  cwd: string;
  /** The P3b sandbox-profile fingerprint this child booted with (mounts +
   * allowlist + cwd + home — see child-sandbox.ts agentProfileFingerprint).
   * getAgentServe recomputes the desired fingerprint on every acquire and
   * recycles on a mismatch — this subsumes the old cwd-only staleness check
   * (cwd is one of the fingerprint's inputs) and additionally catches a
   * mount/allowlist flip (e.g. RO→RW edit-mode grant) on the SAME cwd. */
  fingerprint: string;
  markStale(reason: StaleReason): void;
  isStale(): boolean;
  isClosed(): boolean;
  /** Kill the serve child, stop its SSE consumer, revoke its bridge token AND
   * its egress-proxy credential (P3b), evict it from the pool. LEAVES the
   * serve root on disk (evictTask rm's it). */
  close(): Promise<void>;
}

/** How to place the child's cwd: a repo agent's clone, else a synthetic root. */
export interface AgentServeSpec { clonePath?: string }

interface PoolEntry {
  promise: Promise<ServeHandle>;
  handle: ServeHandle | null; // set when the boot resolves; null while booting
  /** The serve cwd this entry is booting/booted with. Tracked so an in-flight
   * boot (handle still null) is visible to the shared-clone collision guard. */
  desiredCwd: string;
}

const pool = new Map<string, PoolEntry>();
// Per-boot generation token (mirrors llm-one-shot.ts): a closeServePool() that
// happens WHILE a boot is in flight bumps this, so that boot's post-spawn guard
// always sees a mismatch and self-aborts — even if a later getAgentServe has
// since started a fresh boot (whose entry was already cleared from the pool by
// the teardown, so nothing else could ever close its child → ~300MB orphan).
let poolGeneration = 0;

/** How long evictTask waits on an in-flight boot before dropping the entry and
 * removing the root anyway, so a wedged `opencode serve` spawn can't hang task
 * teardown. Comfortably above the embedded-server 15s start timeout, so a
 * normally-booting child is never abandoned; only a genuinely stuck spawn hits it. */
const EVICT_BOOT_WAIT_MS = 30_000;

const poolKey = (taskId: string, agentId: string): string => `${taskId}:${agentId}`;
const taskServeRoot = (taskId: string): string => join(WORKDIR, 'opencode-server', safePathSegment(taskId, 'taskId'));
const syntheticRoot = (taskId: string, agentId: string): string => join(taskServeRoot(taskId), safePathSegment(agentId, 'agentId'));

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
 * its child is reaped. 15m default is safe: reap is context-free — the agent's
 * per-agent session store (agentHomeDir, on the workdir volume) outlives the
 * reaped child, so the next boot resumes it. */
export function childIdleTtlMs(): number {
  return parseDurationMs(process.env.OPENCODE_CHILD_IDLE_TTL) ?? 15 * 60_000;
}

/** OPENCODE_CHILD_SOFT_CAP — census-warn threshold. Telemetry only in P3a:
 * never queues or blocks a spawn. */
export function childSoftCap(): number {
  const n = Number(process.env.OPENCODE_CHILD_SOFT_CAP);
  return Number.isInteger(n) && n > 0 ? n : 12;
}

/** True when a pool entry holds a booted, not-yet-closed child. Shared by
 * liveChildCount and the census warn so both count the same thing (a live
 * child) — not booting or already-closed entries. */
function isLiveEntry(entry: PoolEntry): boolean {
  return entry.handle != null && !entry.handle.isClosed();
}

export function liveChildCount(): number {
  let n = 0;
  for (const entry of pool.values()) if (isLiveEntry(entry)) n++;
  return n;
}

/** The keys of the currently-live children — the census for the soft-cap warn.
 * Live-only (via isLiveEntry) so a booting or closed entry can't pollute an
 * incident readout. */
function liveChildKeys(): string[] {
  const keys: string[] = [];
  for (const [key, entry] of pool) if (isLiveEntry(entry)) keys.push(key);
  return keys;
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

  // Effective serve cwd, resolving a shared-clone cwd collision (see below) to
  // this agent's synthetic root. Computed BEFORE the warm-handle check so the
  // mode-transition comparison (handle.cwd !== desiredCwd) tests against the
  // EFFECTIVE cwd — otherwise a sticky fallback would fight the recycle logic.
  let desiredCwd = spec.clonePath ?? syntheticRoot(task.taskId, agent.def.id);
  if (spec.clonePath) {
    // Same-task repo agents can share ONE clone (task-shared clones): two
    // children in the same cwd clobber each other's `.opencode/skills`
    // (clear-and-rebuild staging) and load the OTHER's bridge token from the
    // fixed-name plugin file — the bridge identity cross-check then rejects
    // every tool call (functional lockout by the security feature). If ANY
    // other live/in-flight entry already occupies this clone, fall back to a
    // synthetic root so this agent's skills+plugin live in its own dir.
    // Degrades to pre-P3a for the second agent (it addresses the clone by
    // absolute path; SERVE_PERMISSION allows external_directory). Re-checked
    // on every acquire, so the fallback is sticky only while the occupant
    // lives — once it's gone, the clone cwd is used again (next turn boundary).
    const occupant = [...pool.entries()].find(([otherKey, other]) => {
      if (otherKey === key) return false;
      const otherCwd = other.handle
        ? (other.handle.isClosed() ? undefined : other.handle.cwd)
        : other.desiredCwd; // in-flight boot
      return otherCwd === spec.clonePath;
    });
    if (occupant) {
      const fallback = syntheticRoot(task.taskId, agent.def.id);
      logger.warn('opencode', `opencode[${key}]: clone cwd ${spec.clonePath} already in use by opencode[${occupant[0]}] — booting in synthetic root ${fallback} (skills+bridge-plugin isolation; degrades to pre-P3a for this agent)`);
      desiredCwd = fallback;
    }
  }
  const isClone = spec.clonePath != null && desiredCwd === spec.clonePath;

  const existing = pool.get(key);
  if (existing) {
    const handle = await existing.promise.catch(() => null); // a failed boot was already evicted
    if (handle && !handle.isClosed()) {
      // Proxy-free fingerprint recompute (no credential minted on this warm
      // path) — subsumes the old cwd-only check (cwd is a fingerprint input,
      // so a clone re-create at a NEW path — RO→RW — still recycles) AND
      // additionally catches a mount/allowlist flip on the SAME cwd (e.g. an
      // edit-mode grant mid-task) or a max-mode model swap, which the old cwd
      // comparison couldn't see.
      const desiredFp = agentProfileFingerprint(agent, task, desiredCwd, agent.editModeAtSpawn === true, task.metadata.max_mode === true);
      if (handle.fingerprint !== desiredFp) {
        handle.markStale('mode-transition'); // cwd OR mount/allowlist drift (RO→RW, etc.)
      }
      if (!handle.isStale()) return handle;
      await handle.close(); // turn-boundary recycle: fresh boot below re-stages skills
    }
  }

  const entry: PoolEntry = { promise: undefined as unknown as Promise<ServeHandle>, handle: null, desiredCwd };
  entry.promise = bootChild(agent, task, key, desiredCwd, isClone, entry);
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
  const myGeneration = poolGeneration; // bumped by closeServePool → post-spawn guard self-aborts
  const skillsDir = join(cwd, '.opencode', 'skills');
  const pluginsDir = join(cwd, '.opencode', 'plugins');
  const nodeModulesDir = join(cwd, '.opencode', 'node_modules');

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
  // Set once the P3b sandbox profile is built (mints the egress-proxy
  // credential). Captured in outer scope — like bridge/token above — so a
  // later failure (in wrapServeCommand or startEmbeddedServer) can still
  // revoke the credential via the boot-failure catch.
  let proxy: Awaited<ReturnType<typeof getEgressProxy>> | undefined;
  let profile: ReturnType<typeof buildChildSandboxProfile> | undefined;
  try {
    const [, mcp] = await Promise.all([
      isClone ? Promise.resolve() : prepareServeRoot(cwd),
      buildOpencodeMcpConfig(),
      // The child's per-agent HOME/XDG_DATA_HOME dir (session-store
      // isolation). CRITICAL: must exist on disk before wrapServeCommand runs
      // — buildSandboxArgv silently skips a nonexistent bind SOURCE, so a
      // missing homeDir would boot the child with no writable HOME at all.
      mkdir(agentHomeDir(task.taskId, agent.def.id), { recursive: true }),
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
      // P3b: vendor the bridge plugin's dependency (@opencode-ai/plugin) into
      // the child's .opencode/node_modules so opencode resolves it offline. The
      // egress jail denies registry.npmjs.org to non-(edit-mode-repo) agents,
      // which would otherwise 403 opencode's boot-time auto-install and leave
      // the bridge with zero tools (a live-smoke merge blocker). Best-effort +
      // loud warn: a copy failure shouldn't kill the boot (on darwin dev the
      // open-egress auto-install still works), but under the jail it means the
      // bridge won't load, so the warn must be actionable.
      (async () => {
        try {
          await vendorBridgeDeps(nodeModulesDir);
        } catch (err) {
          logger.warn('opencode', `opencode[${key}]: bridge-dep vendoring failed — the bridge plugin will have no tools under the egress sandbox: ${err instanceof Error ? err.message : String(err)}`);
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
    // Max mode (a task-lifetime, monotonic grant) may swap repo/dynamic agents
    // onto ARCHIE_MAX_MODE_MODEL; read it live from task metadata (set before
    // the approval resumes the task, so it's current for the child being
    // booted) and thread it through the route, the sandbox egress allowlist,
    // and the recycle fingerprint so a mid-task grant recycles onto the model.
    const maxMode = task.metadata.max_mode === true;
    const model = resolveAgentOpencodeModel(agent.def, maxMode);

    // P3b: build the per-child OS-sandbox profile (bwrap mounts + egress
    // allowlist), mint this child's proxy credential, and wrap the spawn.
    // editAllowed is the exact edit-mode snapshot prepareAgentContext froze
    // for this spawn (the same signal the runtime's readOnly derivation
    // uses); a mid-task edit-mode grant re-spawns the agent, so it's current
    // for the child being booted.
    proxy = await getEgressProxy();
    const editAllowed = agent.editModeAtSpawn === true;
    profile = buildChildSandboxProfile({ agent, task, cwd, editAllowed, maxMode, proxy });
    const fingerprint = agentProfileFingerprint(agent, task, cwd, editAllowed, maxMode);
    const { command, args } = await wrapServeCommand(profile);

    // Spawn, jailed (Linux: bwrap; darwin: unwrapped dev parity — see
    // wrapServeCommand) and with the pruned per-child env (no orchestrator
    // secrets, no process.env leak — see embedded-server.ts).
    const server = await startEmbeddedServer({
      cwd,
      config: { model: `${model.providerID}/${model.modelID}`, permission: SERVE_PERMISSION, mcp },
      spawnOverride: { command, args },
      env: profile.env,
    });
    if (poolGeneration !== myGeneration) {
      try { server.close(); } catch { /* best-effort */ }
      liveBridge.revokeChildToken(liveToken);
      proxy.revokeCredential(profile.cred);
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
      fingerprint,
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
        proxy!.revokeCredential(profile!.cred);
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
      // Census lists only LIVE children (+ this key, being booted) — booting/
      // closed entries must not pollute an incident readout.
      const census = [...liveChildKeys(), key].join(', ');
      logger.warn('opencode', `live serve children (${live}) exceed OPENCODE_CHILD_SOFT_CAP (${cap}) — census: ${census}`);
    }
    return handle;
  } catch (err) {
    // The bridge branch may not have run to completion (or at all, if
    // Promise.all short-circuited on a different branch's rejection) — only
    // revoke a token that was actually minted.
    if (bridge && token) bridge.revokeChildToken(token);
    // Likewise, only revoke a proxy credential that was actually minted
    // (buildChildSandboxProfile succeeded before a later failure, e.g. in
    // wrapServeCommand or startEmbeddedServer).
    if (proxy && profile) proxy.revokeCredential(profile.cred);
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
    logger.system(`opencode[${key}]: parked > ${childIdleTtlMs()}ms — reaping child (root + per-agent session store kept; next boot resumes from it)`);
    void handle.close();
  }, childIdleTtlMs());
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Plugins push: mark every live child stale; each recycles at its next turn
 * boundary (tiny blast radius). Children still booting stage fresh skills by
 * construction. */
export function markAllServesStale(reason: StaleReason): void {
  // `?.` skips in-flight boots (null handle) deliberately: a boot running now
  // stages from the just-refreshed plugins by construction, so it needs no
  // stale mark — only already-booted children hold a frozen skill set.
  for (const entry of pool.values()) entry.handle?.markStale(reason);
}

/** Task teardown: close any children still open for the task and rm the task's
 * synthetic serve-root dir — the ONLY place roots are removed (A5). */
export async function evictTask(taskId: string): Promise<void> {
  const prefix = `${taskId}:`;
  for (const [key, entry] of [...pool.entries()]) {
    if (!key.startsWith(prefix)) continue;
    // Prefer the resolved handle; otherwise await the in-flight boot — but
    // BOUND that await, so a wedged spawn (a hung `opencode serve`) can't hang
    // task teardown indefinitely. On timeout we drop the pool entry and rm the
    // root anyway: if that boot ever completes, its own close() self-guards via
    // `pool.get(key) === entry` (the entry is gone, so it evicts itself) and
    // its child is `--die-with-parent`, so it dies with the daemon regardless.
    let handle = entry.handle;
    if (!handle) {
      // Whatever the wait outcome below, guarantee a late-resolving boot that
      // finds its entry already evicted closes ITSELF (kills the serve child +
      // revokes its tokens) rather than orphaning a live process. close() is
      // idempotent, so this is safe even when the race resolves in time.
      void entry.promise.then((h) => { if (h && pool.get(key) !== entry) void h.close(); }).catch(() => {});
      handle = await Promise.race([
        entry.promise.catch(() => null),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => {
            logger.warn('opencode', `evictTask(${taskId}): boot for ${key} did not settle within ${EVICT_BOOT_WAIT_MS}ms — dropping the entry; the late boot self-closes when it resolves`);
            resolve(null);
          }, EVICT_BOOT_WAIT_MS);
          t.unref?.();
        }),
      ]);
    }
    if (handle) await handle.close();
    pool.delete(key);
  }
  await rm(taskServeRoot(taskId), { recursive: true, force: true });
}

/** Process shutdown: close every RESOLVED child and clear the pool. Does NOT
 * await in-flight boots (a hung spawn would block shutdown); those are handled
 * by the generation-token guard in bootChild, which closes a child that
 * finishes booting after teardown began. Bumping the generation (rather than a
 * boolean) means a later fresh getAgentServe can boot cleanly on the next
 * generation while any still-in-flight pre-teardown boot stays doomed. */
export async function closeServePool(): Promise<void> {
  poolGeneration++;
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map(async (entry) => {
    if (entry.handle) await entry.handle.close();
  }));
}
