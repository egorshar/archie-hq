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
import { mkdir } from 'node:fs/promises';
import type { LlmOneShot, LlmTextRequest, LlmJsonRequest } from '../../ports/llm-one-shot.js';
import { logger } from '../../system/logger.js';
import { WORKDIR } from '../../system/workdir.js';
import { resolveOpencodeModel } from './model.js';
import { concatPromptText } from './server.js';
import { startEmbeddedServer, prepareServeRoot, SERVE_PERMISSION, type OpencodeClient, type EmbeddedServer } from './embedded-server.js';
import { buildOneShotSandboxProfile, wrapServeCommand, type EgressCredential } from './child-sandbox.js';
import { getEgressProxy, type EgressProxyHandle } from './egress-proxy.js';

/**
 * Singleton utility serve for one-shot LLM calls (P3a §7): one small
 * `opencode serve` OUTSIDE the per-agent pool — no skills, no bridge plugin, no
 * MCP servers (one-shots never call tools). Untouched by the pool's
 * stale-marking / idle-reap / recycle (A6). Booted lazily; closed on shutdown.
 * config.model = the one-shot route ('haiku' → ARCHIE_OPENCODE_MODEL_HAIKU or
 * the DEFAULT fallback); callers still pass body.model per request.
 */
/** The resolved utility server, plus the P3b egress-proxy credential minted
 * for it — carried on the resolved value (not an outer variable) so
 * closeOneShotServe always revokes the credential belonging to the SAME boot
 * it's tearing down, never a newer boot's (mirrors the identity-guarded
 * servePromise-nulling below). */
interface OneShotServer extends EmbeddedServer {
  egressProxy: EgressProxyHandle;
  egressCred: EgressCredential;
}

let servePromise: Promise<OneShotServer> | null = null;
// Per-boot generation token: a close() that happens WHILE a boot is in flight
// bumps this, so that boot's post-spawn guard always sees a mismatch and
// self-aborts — even if a later boot has since started and reset servePromise.
let bootGeneration = 0;

function getOneShotClient(): Promise<OpencodeClient> {
  if (!servePromise) {
    const myGeneration = bootGeneration;
    const boot: Promise<OneShotServer> = (async () => {
      const root = join(WORKDIR, 'opencode-server', 'one-shot');
      await prepareServeRoot(root);
      // P3b: minimal sandbox profile (no repo mounts — the one-shot never
      // touches a clone) + its own proxy credential + its own home dir.
      const proxy = await getEgressProxy();
      // homeDir is a SIBLING of root, not `<root>/home` — opencode snapshots its
      // cwd (=root) every turn, so a store under root would be recursively
      // snapshotted (the runaway-growth bug fixed in agentHomeDir). Kept under
      // opencode-server/ so shutdown/cleanup still finds it.
      const homeDir = join(WORKDIR, 'opencode-server', 'one-shot-home');
      await mkdir(homeDir, { recursive: true }); // must exist before the wrapped spawn (bind-source invariant)
      // Profile cwd == spawn cwd (`root`) — see buildOneShotSandboxProfile. The
      // credential is minted here; any throw after this point (wrapServeCommand,
      // startEmbeddedServer, or the shutdown-abort below) must revoke it, so the
      // whole boot body runs under a catch that revokes (mirrors bootChild).
      const profile = buildOneShotSandboxProfile({ root, homeDir, proxy });
      try {
        const { command, args } = await wrapServeCommand(profile);
        const model = resolveOpencodeModel('haiku');
        const server = await startEmbeddedServer({
          cwd: root,
          config: { model: `${model.providerID}/${model.modelID}`, permission: SERVE_PERMISSION },
          spawnOverride: { command, args },
          env: profile.env,
        });
        if (bootGeneration !== myGeneration) {
          try { server.close(); } catch { /* best-effort */ }
          throw new Error('one-shot serve boot aborted during shutdown');
        }
        return { ...server, egressProxy: proxy, egressCred: profile.cred };
      } catch (err) {
        proxy.revokeCredential(profile.cred);
        throw err;
      }
    })().catch((err) => {
      // Identity-guarded: only clear the singleton if it still points at THIS
      // boot — a stale boot's failure (e.g. a close-during-boot self-abort) must
      // not null out a newer boot's live chain and orphan its server.
      if (servePromise === boot) servePromise = null; // allow a later call to retry a failed startup
      throw err;
    });
    servePromise = boot;
  }
  return servePromise.then((s) => s.client);
}

/** Tear down the utility serve (idempotent; no-op if never booted). Revokes
 * this boot's own egress-proxy credential (P3b) alongside killing the child. */
export async function closeOneShotServe(): Promise<void> {
  bootGeneration++;
  if (!servePromise) return;
  const p = servePromise;
  servePromise = null;
  const server = await p.catch(() => null);
  if (server) {
    try { server.close(); } catch { /* already gone */ }
    server.egressProxy.revokeCredential(server.egressCred);
  }
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
