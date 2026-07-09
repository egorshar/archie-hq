/**
 * Embedded opencode server — the ONE place the server is started (spec R4:
 * confine vendor surface to src/runtime/opencode/). Started lazily once and
 * reused for the process lifetime; shared by the LlmOneShot and the AgentRuntime.
 */
import { createOpencode } from '@opencode-ai/sdk';
import { logger } from '../../system/logger.js';

export type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];

let clientPromise: Promise<OpencodeClient> | null = null;

/** Lazily start (once) and reuse the embedded opencode server's client. */
export function getOpencodeClient(): Promise<OpencodeClient> {
  if (!clientPromise) {
    // port 0 → an ephemeral free port (the SDK parses the actual URL the server
    // prints). Avoids colliding with the default 4096 when a prior embedded
    // server lingers or multiple instances run.
    clientPromise = createOpencode({ port: 0 })
      .then((r) => r.client)
      .catch((err) => {
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
