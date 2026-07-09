/**
 * OpencodeLlmOneShot — opencode implementation of the LlmOneShot port
 * (spec §3.4). Runs an embedded opencode server (started lazily once and
 * reused) and issues one prompt per call.
 *
 * Note: opencode SDK 1.17.16 has no native structured-output param, so json()
 * instructs the model to emit schema-conforming JSON and parses it (the caller
 * re-validates with its own schema, per the port contract). All opencode
 * imports are confined to this module (spec R4).
 */
import { createOpencode } from '@opencode-ai/sdk';
import type { LlmOneShot, LlmTextRequest, LlmJsonRequest } from '../../ports/llm-one-shot.js';
import { logger } from '../../system/logger.js';
import { resolveOpencodeModel } from './model.js';

type OpencodeClient = Awaited<ReturnType<typeof createOpencode>>['client'];

let clientPromise: Promise<OpencodeClient> | null = null;

/** Lazily start (once) and reuse the embedded opencode server's client. */
function getClient(): Promise<OpencodeClient> {
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

/** Concatenate the text parts of a session.prompt() response, or null on error. */
function readText(res: { data?: any; error?: unknown }): string | null {
  if (res?.error) {
    logger.error('opencode', `prompt HTTP error: ${JSON.stringify(res.error)}`);
    return null;
  }
  const info = res?.data?.info;
  if (info?.error) {
    logger.error('opencode', `prompt failed: ${info.error.name ?? 'error'}`);
    return null;
  }
  const parts = Array.isArray(res?.data?.parts) ? res.data.parts : [];
  const text = parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('')
    .trim();
  return text ? text : null;
}

export class OpencodeLlmOneShot implements LlmOneShot {
  readonly kind = 'opencode' as const;

  async text(req: LlmTextRequest): Promise<string | null> {
    try {
      const model = resolveOpencodeModel(req.model);
      const client = await getClient();
      const created = await client.session.create({ body: { title: 'archie-one-shot' } });
      const sessionId = (created as any)?.data?.id;
      if (!sessionId) {
        logger.error('opencode', 'session.create returned no session id');
        return null;
      }
      const res = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model,
          parts: [{ type: 'text', text: req.prompt }],
          ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
        },
      });
      return readText(res as any);
    } catch (err) {
      logger.error('opencode', `one-shot text() failed: ${(err as Error).message}`);
      return null;
    }
  }

  async json(req: LlmJsonRequest): Promise<unknown | null> {
    // No native structured output — ask for schema-conforming JSON, then parse.
    const schema = JSON.stringify(req.jsonSchema);
    const prompt =
      `${req.prompt}\n\n` +
      `Respond with ONLY a JSON object conforming to this JSON Schema — no prose, no code fences:\n${schema}`;
    const raw = await this.text({ ...req, prompt });
    if (raw === null) return null;
    const stripped = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    try {
      return JSON.parse(stripped);
    } catch {
      logger.error('opencode', 'json() could not parse model output as JSON');
      return null;
    }
  }
}

export const opencodeLlmOneShot = new OpencodeLlmOneShot();
