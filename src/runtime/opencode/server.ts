/**
 * Shared opencode process-singletons (P3a): the bridge listener (getBridge /
 * closeBridge — ONE loopback listener + sharedRegistry for the whole process;
 * per-child tokens are minted per serve child by the pool) and prompt-response
 * helpers. Serve children live in serve-pool.ts (one per agent instance); the
 * LlmOneShot utility serve lives in llm-one-shot.ts.
 */
import { logger } from '../../system/logger.js';
import { startBridgeServer, type BridgeHandle } from './bridge/server.js';
import { SessionRegistry } from './bridge/registry.js';
import { type OpencodeClient } from './embedded-server.js';

export type { OpencodeClient };

/**
 * Shared session registry: opencode sessionId -> the live Archie
 * `{task, agent}` pair the bridge dispatches control-tool calls against.
 * Exported so `OpencodeRuntime` can `set`/`delete` entries as turns start and
 * end; the server module itself only threads it into `startBridgeServer`.
 */
export const sharedRegistry = new SessionRegistry();

/**
 * Bridge singleton (P3a §2): ONE loopback listener + sharedRegistry for the
 * whole process, shared by every per-agent serve child. Children get their own
 * bearer tokens via bridge.mintChildToken (bridge/server.ts, A4); this module
 * only owns the listener's lifecycle.
 */
let bridgePromise: Promise<BridgeHandle> | null = null;

export function getBridge(): Promise<BridgeHandle> {
  if (!bridgePromise) {
    bridgePromise = startBridgeServer(sharedRegistry).catch((err) => {
      bridgePromise = null; // allow a later call to retry a failed startup
      throw err;
    });
  }
  return bridgePromise;
}

/** Close the bridge listener (idempotent; no-op if never started) and clear the
 * singleton so a later getBridge() re-boots cleanly. */
export async function closeBridge(): Promise<void> {
  if (!bridgePromise) return;
  const p = bridgePromise;
  bridgePromise = null;
  const handle = await p.catch(() => null);
  if (handle) await handle.close();
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
