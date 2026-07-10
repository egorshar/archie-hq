/**
 * Embedded opencode server — the ONE place the server is started (spec R4:
 * confine vendor surface to src/runtime/opencode/). Started lazily once and
 * reused for the process lifetime; shared by the LlmOneShot and the AgentRuntime.
 *
 * ALWAYS wires in the tool bridge + model/permission config, regardless of
 * which caller (the one-shot LLM path or OpencodeRuntime) triggers the first
 * boot (fixes the "first caller decides whether the bridge exists"
 * race — a one-shot firing before any agent turn still yields a
 * bridge-equipped server; one-shots simply never call the bridged control
 * tools).
 */
import { join } from 'node:path';
import { logger } from '../../system/logger.js';
import { writeBridgePlugin } from './bridge/plugin-source.js';
import { startBridgeServer, type BridgeHandle } from './bridge/server.js';
import { SessionRegistry } from './bridge/registry.js';
import { resolveOpencodeModel } from './model.js';
import { startEventConsumer, type EventConsumerHandle } from './events.js';
import { buildOpencodeMcpConfig } from './mcp-config.js';
import { startEmbeddedServer, prepareServeRoot, type OpencodeClient } from './embedded-server.js';
import { stageOpencodeSkills } from './skills.js';
import { WORKDIR, getPluginsHeadInfo } from '../../system/workdir.js';

export type { OpencodeClient };

/**
 * Shared session registry: opencode sessionId -> the live Archie
 * `{task, agent}` pair the bridge dispatches control-tool calls against.
 * Exported so `OpencodeRuntime` can `set`/`delete` entries as turns start and
 * end; the server module itself only threads it into `startBridgeServer`.
 */
export const sharedRegistry = new SessionRegistry();

/**
 * Read-only permission recipe: allow reads/webfetch/
 * external-directory access so the turn doesn't hang on a permission ask.
 * RO enforcement (denying edit/bash while read-only) is handled elsewhere, NOT here.
 */
const READ_ONLY_PERMISSION = {
  edit: 'allow',
  bash: 'allow',
  webfetch: 'allow',
  external_directory: 'allow',
} as const;

/**
 * Logical model name for the server-global `config.model` route. `config.model`
 * is set once for the whole embedded-server singleton: it isn't
 * per-prompt, so a single shared-server default is required. Per-agent routing
 * is applied per turn via `body.model` (runtime.ts `resolveAgentOpencodeModel`);
 * this generic `default` route (env `ARCHIE_OPENCODE_MODEL_DEFAULT`) is only the
 * fallback used when a turn omits `body.model`.
 */
const SERVER_MODEL_LOGICAL = 'default';

let clientPromise: Promise<OpencodeClient> | null = null;
let bridgeHandle: BridgeHandle | null = null;
let eventConsumer: EventConsumerHandle | null = null;
/**
 * Set while `closeOpencodeBridge` is tearing down. Guards the shutdown-during-
 * first-boot race: if SIGTERM lands while the initial `createOpencode` is still
 * in flight, teardown finds `serverHandle`/`eventConsumer` still null and can't
 * stop them — so when the boot resolves it must NOT re-establish them (that
 * would re-orphan the very serve child this module closes). Reset on each fresh
 * boot so a later `getOpencodeClient` re-boots cleanly.
 */
let shuttingDown = false;
/**
 * Handle for the embedded `opencode serve` child process. `createOpencode`
 * returns `{ client, server: { url, close() } }`; keeping `server` is what lets
 * `closeOpencodeBridge` actually terminate the child on shutdown. Without it the
 * child was orphaned on every dev reload (a fresh one spawned per restart —
 * ~10 leaked `opencode serve` processes observed).
 */
let serverHandle: { close(): void } | null = null;

/**
 * Lazily start (once) and reuse the embedded opencode server's client.
 *
 * On first call: starts the bridge listener (`startBridgeServer`), places the
 * generated bridge plugin into `<serverCwd>/.opencode/plugins/` with the live
 * url+token (plugins load from `<serverCwd>/.opencode/plugins/*.ts`,
 * server cwd = the process cwd — Archie is always launched from its project
 * root, which is writable and stable, so no `process.chdir()`/project-dir
 * override is needed here), resolves the server-global model route, and boots
 * `createOpencode` with `config.model` + `config.permission` set so the turn
 * doesn't hang and uses the intended model. If bridge startup
 * or the opencode boot fails, the bridge (if started) is closed and the
 * promise is cleared so a later call can retry cleanly.
 */
export function getOpencodeClient(): Promise<OpencodeClient> {
  if (!clientPromise) {
    shuttingDown = false;
    clientPromise = (async () => {
      const bridge = await startBridgeServer(sharedRegistry);
      bridgeHandle = bridge;
      try {
        // Run the serve child in a clean, git-bounded staging root (NOT the repo
        // cwd) so opencode's skill discovery — which scans the serve process's
        // working directory — sees only the skills WE stage, not the repo's own
        // `.claude/skills`. `git init` makes the root its own worktree so
        // opencode's upward walk stops here instead of reaching the repo.
        const serveRoot = join(WORKDIR, 'opencode-server');
        await prepareServeRoot(serveRoot);
        // Stage the union of all agents' skills into the serve root so the shared
        // server's native `skill` tool exposes them (global; see skills.ts).
        // Best-effort: a staging failure must not sink the server boot.
        try {
          await stageServeRootSkills('boot');
        } catch (err) {
          logger.warn('opencode', `skill staging failed (agents run without skills): ${err instanceof Error ? err.message : String(err)}`);
        }

        const pluginsDir = join(serveRoot, '.opencode', 'plugins');
        await writeBridgePlugin(pluginsDir, bridge.url, bridge.token);

        const model = resolveOpencodeModel(SERVER_MODEL_LOGICAL);
        const mcp = await buildOpencodeMcpConfig();
        // Manual spawn (embedded-server.ts) with cwd = serveRoot — the one thing
        // the SDK's createOpencode can't do. port 0 → an ephemeral free port.
        const r = await startEmbeddedServer({
          cwd: serveRoot,
          config: {
            model: `${model.providerID}/${model.modelID}`,
            permission: READ_ONLY_PERMISSION,
            mcp,
          },
        });
        if (shuttingDown) {
          // Teardown ran while this boot was in flight — close the just-spawned
          // child instead of re-establishing it (else it outlives shutdown).
          try {
            r.close();
          } catch {
            // best-effort
          }
          throw new Error('opencode server boot aborted during shutdown');
        }
        serverHandle = { close: r.close };
        eventConsumer = startEventConsumer(r.client, sharedRegistry);
        return r.client;
      } catch (err) {
        await bridge.close().catch(() => {});
        bridgeHandle = null;
        throw err;
      }
    })().catch((err) => {
      clientPromise = null; // allow a later call to retry a failed startup
      throw err;
    });
  }
  return clientPromise;
}

/**
 * Tear down the embedded opencode server: stop the SSE event consumer, close
 * the `opencode serve` child process, and close the bridge listener. No-op for
 * any piece that never booted. Intended to be called from a process-level
 * shutdown path (SIGINT/SIGTERM); never logs the bridge token. Clears the
 * cached client promise so a later `getOpencodeClient` re-boots cleanly.
 */
export async function closeOpencodeBridge(): Promise<void> {
  shuttingDown = true;
  if (eventConsumer) {
    eventConsumer.stop();
    eventConsumer = null;
  }
  if (serverHandle) {
    const handle = serverHandle;
    serverHandle = null;
    try {
      handle.close();
    } catch {
      // best-effort: the child may already be gone
    }
  }
  if (bridgeHandle) {
    const handle = bridgeHandle;
    bridgeHandle = null;
    await handle.close();
  }
  clientPromise = null;
}

/** Absolute path of the embedded serve root's staged-skills dir. */
const serveRootSkillsDir = (): string => join(WORKDIR, 'opencode-server', '.opencode', 'skills');

/**
 * Stage the union of every agent's skills into the embedded serve root and log
 * provenance. The ONE place staging + its log line live, shared by the boot
 * path (`trigger='boot'`) and the plugins-refresh re-stage
 * (`trigger='plugins-refresh'`). `linkAgentSkills` is clear-and-rebuild, so this
 * is idempotent and needs no extra cleanup. The plugins HEAD short SHA is read
 * best-effort (a cheap `git log -1` via `getPluginsHeadInfo`); a failure to read
 * it only omits the SHA from the log, never blocks staging. Throws only if the
 * staging itself fails — callers wrap it best-effort.
 */
async function stageServeRootSkills(trigger: 'boot' | 'plugins-refresh'): Promise<void> {
  const n = await stageOpencodeSkills(serveRootSkillsDir());
  let head: string | undefined;
  try {
    head = (await getPluginsHeadInfo())?.shortSha;
  } catch {
    head = undefined; // provenance is optional — never let it break staging/logging
  }
  logger.system(`opencode: staged skills from ${n} source(s) (trigger=${trigger}${head ? `, plugins=${head}` : ''})`);
}

/**
 * Re-stage state. Concurrent triggers coalesce: while a re-stage runs, further
 * calls flip `restageQueued` so EXACTLY ONE trailing run follows, guaranteeing
 * the final on-disk staging reflects the newest plugins state (a burst collapses
 * to at most one in-flight + one trailing run).
 *
 * We deliberately do NOT pause agent turns during `linkAgentSkills`' rm+rebuild.
 * That leaves a brief window where a skill path is momentarily absent, but a
 * transient skill-read miss is acceptable and self-heals on the agent's retry —
 * far cheaper than coupling re-staging to every in-flight turn's lifecycle.
 */
let restageInFlight: Promise<void> | null = null;
let restageQueued = false;

/**
 * Re-stage the shared embedded server's skills dir against the current agent set
 * (call AFTER the registry is rebuilt so `getAllAgentDefs()` reflects the new
 * plugins). Contract:
 *   - NO-OP when the embedded server has NOT started. The check reads the
 *     `clientPromise` singleton SYNCHRONOUSLY and never awaits/creates it, so
 *     re-staging never boots the server just to stage.
 *   - Best-effort: a failed re-stage is logged and swallowed — it must never
 *     break the plugins refresh or crash the daemon; the previous staging
 *     remains in effect.
 *   - Serialized + coalesced (see `restageInFlight`/`restageQueued`).
 */
export async function restageOpencodeSkills(): Promise<void> {
  // Synchronous singleton read — `null` means "never started". Do NOT touch
  // getOpencodeClient() here (that would boot the server).
  if (clientPromise === null) return;

  if (restageInFlight) {
    // A re-stage is already running; schedule exactly one trailing run so the
    // final state reflects the newest plugins, and share the in-flight promise.
    restageQueued = true;
    return restageInFlight;
  }

  restageInFlight = (async () => {
    try {
      do {
        restageQueued = false;
        try {
          await stageServeRootSkills('plugins-refresh');
        } catch (err) {
          logger.warn(
            'opencode',
            `skill re-stage failed after plugins refresh (previous staging remains in effect): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } while (restageQueued);
    } finally {
      restageInFlight = null;
    }
  })();
  return restageInFlight;
}

/** Concatenate the text parts of a session.prompt() response, or null on error/empty. */
export function concatPromptText(res: unknown): string | null {
  const r = res as { data?: any; error?: unknown };
  if (r?.error) {
    logger.error('opencode', `prompt HTTP error: ${JSON.stringify(r.error)}`);
    return null;
  }
  const info = r?.data?.info;
  if (info?.error) {
    logger.error('opencode', `prompt failed: ${info.error.name ?? 'error'}`);
    return null;
  }
  const parts = Array.isArray(r?.data?.parts) ? r.data.parts : [];
  const text = parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('')
    .trim();
  return text ? text : null;
}
