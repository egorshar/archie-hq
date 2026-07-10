/**
 * OpencodeLlmOneShot — opencode implementation of the LlmOneShot port
 * (spec §3.4). Runs its OWN tiny embedded opencode server (P3a §7) — a
 * singleton utility serve outside the per-agent pool, with no skills, no
 * bridge plugin, and no MCP servers (one-shots never call tools) — started
 * lazily once and reused, and issues one prompt per call.
 *
 * Note: opencode SDK 1.17.16 has no native structured-output param, so json()
 * instructs the model to emit schema-conforming JSON and parses it (the caller
 * re-validates with its own schema, per the port contract). `concatPromptText`
 * is still shared from ./server.js; all opencode SDK imports are confined to
 * src/runtime/opencode/ (spec R4).
 */
import { join } from 'node:path';
import type { LlmOneShot, LlmTextRequest, LlmJsonRequest } from '../../ports/llm-one-shot.js';
import { logger } from '../../system/logger.js';
import { WORKDIR } from '../../system/workdir.js';
import { resolveOpencodeModel } from './model.js';
import { concatPromptText } from './server.js';
import { startEmbeddedServer, prepareServeRoot, SERVE_PERMISSION, type OpencodeClient, type EmbeddedServer } from './embedded-server.js';

/**
 * Singleton utility serve for one-shot LLM calls (P3a §7): one small
 * `opencode serve` OUTSIDE the per-agent pool — no skills, no bridge plugin, no
 * MCP servers (one-shots never call tools). Untouched by the pool's
 * stale-marking / idle-reap / recycle (A6). Booted lazily; closed on shutdown.
 * config.model = the one-shot route ('haiku' → ARCHIE_OPENCODE_MODEL_HAIKU or
 * the DEFAULT fallback); callers still pass body.model per request.
 */
let servePromise: Promise<EmbeddedServer> | null = null;
let shuttingDown = false;

function getOneShotClient(): Promise<OpencodeClient> {
  if (!servePromise) {
    shuttingDown = false;
    servePromise = (async () => {
      const root = join(WORKDIR, 'opencode-server', 'one-shot');
      await prepareServeRoot(root);
      const model = resolveOpencodeModel('haiku');
      const server = await startEmbeddedServer({
        cwd: root,
        config: { model: `${model.providerID}/${model.modelID}`, permission: SERVE_PERMISSION },
      });
      if (shuttingDown) {
        try { server.close(); } catch { /* best-effort */ }
        throw new Error('one-shot serve boot aborted during shutdown');
      }
      return server;
    })().catch((err) => {
      servePromise = null; // allow a later call to retry a failed startup
      throw err;
    });
  }
  return servePromise.then((s) => s.client);
}

/** Tear down the utility serve (idempotent; no-op if never booted). */
export async function closeOneShotServe(): Promise<void> {
  shuttingDown = true;
  if (!servePromise) return;
  const p = servePromise;
  servePromise = null;
  const server = await p.catch(() => null);
  if (server) { try { server.close(); } catch { /* already gone */ } }
}

export class OpencodeLlmOneShot implements LlmOneShot {
  readonly kind = 'opencode' as const;

  async text(req: LlmTextRequest): Promise<string | null> {
    try {
      const model = resolveOpencodeModel(req.model);
      const client = await getOneShotClient();
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
