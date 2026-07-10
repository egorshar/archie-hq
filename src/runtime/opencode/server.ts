/**
 * Embedded opencode server — the ONE place the server is started (spec R4:
 * confine vendor surface to src/runtime/opencode/). Started lazily once and
 * reused for the process lifetime; shared by the LlmOneShot and the AgentRuntime.
 *
 * ALWAYS wires in the tool bridge + model/permission config, regardless of
 * which caller (the one-shot LLM path or OpencodeRuntime) triggers the first
 * boot (Task 4: fixes the "first caller decides whether the bridge exists"
 * race — a one-shot firing before any agent turn still yields a
 * bridge-equipped server; one-shots simply never call the bridged control
 * tools). See src/runtime/opencode/__spike__/spike.md §5 (model routing) and
 * §6 (permission hang fix).
 */
import { createOpencode } from '@opencode-ai/sdk';
import { join } from 'node:path';
import { logger } from '../../system/logger.js';
import { writeBridgePlugin } from './bridge/plugin-source.js';
import { startBridgeServer, type BridgeHandle } from './bridge/server.js';
import { SessionRegistry } from './bridge/registry.js';
import { resolveOpencodeModel } from './model.js';
import { startEventConsumer, type EventConsumerHandle } from './events.js';
import { buildOpencodeMcpConfig } from './mcp-config.js';

export type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];

/**
 * Shared session registry: opencode sessionId -> the live Archie
 * `{task, agent}` pair the bridge dispatches control-tool calls against.
 * Exported so `OpencodeRuntime` can `set`/`delete` entries as turns start and
 * end; the server module itself only threads it into `startBridgeServer`.
 */
export const sharedRegistry = new SessionRegistry();

/**
 * B.1 read-only permission recipe (spike.md §6): allow reads/webfetch/
 * external-directory access so the turn doesn't hang on a permission ask.
 * RO enforcement (denying edit/bash while read-only) is B.2, NOT here.
 */
const READ_ONLY_PERMISSION = {
  edit: 'allow',
  bash: 'allow',
  webfetch: 'allow',
  external_directory: 'allow',
} as const;

/**
 * Logical model name for the server-global `config.model` route. `config.model`
 * is set once for the whole embedded-server singleton (spike.md §5): it isn't
 * per-prompt, so a single shared-server default is required. B.1 is PM-only,
 * so resolving the generic `default` route (env `ARCHIE_OPENCODE_MODEL_DEFAULT`)
 * is sufficient here. If a specialist turn later needs a different model on
 * this same shared server (before B.2's per-role `config.agent.<role>.model`
 * routing lands), that's an escalation — see the note in runtime.ts.
 */
const SERVER_MODEL_LOGICAL = 'default';

let clientPromise: Promise<OpencodeClient> | null = null;
let bridgeHandle: BridgeHandle | null = null;
let eventConsumer: EventConsumerHandle | null = null;
/**
 * Handle for the embedded `opencode serve` child process. `createOpencode`
 * returns `{ client, server: { url, close() } }`; keeping `server` is what lets
 * `closeOpencodeBridge` actually terminate the child on shutdown. Without it the
 * child was orphaned on every dev reload (a fresh one spawned per restart —
 * ~10 leaked `opencode serve` processes observed on 2026-07-10).
 */
let serverHandle: { close(): void } | null = null;

/**
 * Lazily start (once) and reuse the embedded opencode server's client.
 *
 * On first call: starts the bridge listener (`startBridgeServer`), places the
 * generated bridge plugin into `<serverCwd>/.opencode/plugins/` with the live
 * url+token (spike.md §1: plugins load from `<serverCwd>/.opencode/plugins/*.ts`,
 * server cwd = the process cwd — Archie is always launched from its project
 * root, which is writable and stable, so no `process.chdir()`/project-dir
 * override is needed here), resolves the server-global model route, and boots
 * `createOpencode` with `config.model` + `config.permission` set so the turn
 * doesn't hang and uses the intended model (spike.md §5–6). If bridge startup
 * or the opencode boot fails, the bridge (if started) is closed and the
 * promise is cleared so a later call can retry cleanly.
 */
export function getOpencodeClient(): Promise<OpencodeClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const bridge = await startBridgeServer(sharedRegistry);
      bridgeHandle = bridge;
      try {
        const pluginsDir = join(process.cwd(), '.opencode', 'plugins');
        await writeBridgePlugin(pluginsDir, bridge.url, bridge.token);

        const model = resolveOpencodeModel(SERVER_MODEL_LOGICAL);
        const mcp = await buildOpencodeMcpConfig();
        // port 0 → an ephemeral free port (the SDK parses the actual URL the
        // server prints). Avoids colliding with the default 4096 when a prior
        // embedded server lingers or multiple instances run.
        const r = await createOpencode({
          port: 0,
          config: {
            model: `${model.providerID}/${model.modelID}`,
            permission: READ_ONLY_PERMISSION,
            mcp,
          },
        });
        serverHandle = r.server;
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
