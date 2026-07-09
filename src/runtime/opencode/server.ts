/**
 * Embedded opencode server — the ONE place the server is started (spec R4:
 * confine vendor surface to src/runtime/opencode/). Started lazily once and
 * reused for the process lifetime; shared by the LlmOneShot and the AgentRuntime.
 */
import { createOpencode } from '@opencode-ai/sdk';
import { join } from 'node:path';
import { logger } from '../../system/logger.js';
import { writeBridgePlugin } from './bridge/plugin-source.js';

export type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];

/** Live bridge listener info (Task 2's `startBridgeServer`) — baked into the
 * generated plugin so opencode's Bun child can reach it without env-forwarding
 * (spike.md §6). Optional: callers that don't need control tools (the
 * one-shot LLM path) omit it. */
export interface OpencodeBridgeConfig {
  url: string;
  token: string;
}

let clientPromise: Promise<OpencodeClient> | null = null;

/**
 * Lazily start (once) and reuse the embedded opencode server's client.
 *
 * When `bridge` is given (only meaningful on the first call — the server is
 * a process-lifetime singleton), the bridge plugin is generated and written
 * into `<serverCwd>/.opencode/plugins/` BEFORE `createOpencode` so opencode
 * picks it up on this boot (spike.md §1: plugins load from
 * `<serverCwd>/.opencode/plugins/*.ts`, server cwd = the process cwd — Archie
 * is always launched from its project root, which is writable and stable, so
 * no `process.chdir()`/project-dir override is needed here).
 */
export function getOpencodeClient(bridge?: OpencodeBridgeConfig): Promise<OpencodeClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (bridge) {
        const pluginsDir = join(process.cwd(), '.opencode', 'plugins');
        await writeBridgePlugin(pluginsDir, bridge.url, bridge.token);
      }
      // port 0 → an ephemeral free port (the SDK parses the actual URL the server
      // prints). Avoids colliding with the default 4096 when a prior embedded
      // server lingers or multiple instances run.
      const r = await createOpencode({ port: 0 });
      return r.client;
    })().catch((err) => {
      clientPromise = null; // allow a later call to retry a failed startup
      throw err;
    });
  }
  return clientPromise;
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
