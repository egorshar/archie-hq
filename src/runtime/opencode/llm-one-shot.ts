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
import type { LlmOneShot, LlmTextRequest, LlmJsonRequest } from '../../ports/llm-one-shot.js';
import { logger } from '../../system/logger.js';
import { resolveOpencodeModel } from './model.js';
import { getOpencodeClient, concatPromptText } from './server.js';

export class OpencodeLlmOneShot implements LlmOneShot {
  readonly kind = 'opencode' as const;

  async text(req: LlmTextRequest): Promise<string | null> {
    try {
      const model = resolveOpencodeModel(req.model);
      const client = await getOpencodeClient();
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
      return concatPromptText(res);
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
