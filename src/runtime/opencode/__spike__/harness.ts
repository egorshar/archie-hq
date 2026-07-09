/**
 * P2-B.1 Task-1 spike harness (throwaway). Confirms, against a real embedded
 * opencode server driving the local opencode CLI:
 *   1. a plugin in <projectDir>/.opencode/plugins/ loads and registers a custom tool
 *   2. what the custom tool's execute() context exposes (→ the session id)
 *   3. outbound fetch from the plugin reaches a localhost stub
 *   4. tool.execute.before fires and sees the tool name (→ can block)
 *   5. config.model makes opencode use the configured route (model-routing fix)
 *   6. config.permission.external_directory:"allow" avoids the permission hang
 *
 * Run: npx tsx src/runtime/opencode/__spike__/harness.ts
 * Requires: opencode CLI on PATH + an authed provider (OpenRouter) locally.
 */
import { createOpencode } from '@opencode-ai/sdk';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODEL = process.env.SPIKE_MODEL || 'openrouter/anthropic/claude-haiku-4.5';

async function main() {
  const projectDir = join(tmpdir(), 'archie-oc-spike');
  rmSync(projectDir, { recursive: true, force: true });
  const pluginsDir = join(projectDir, '.opencode', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const captureFile = join(projectDir, 'capture.log');
  writeFileSync(captureFile, '');

  // 1) localhost stub the plugin will fetch (stands in for Archie's bridge)
  const hits: Array<{ url?: string; body: string }> = [];
  const stub = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      hits.push({ url: req.url, body: b });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: 'stub-ack' }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  const stubPort = (stub.address() as { port: number }).port;

  // 2) plugin: registers a custom tool + a before-hook; logs everything it sees.
  // Runs inside opencode's Bun runtime — its `@opencode-ai/plugin` import resolves there.
  const plugin = `
import { tool } from "@opencode-ai/plugin";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(captureFile)};
const log = (m) => { try { appendFileSync(LOG, m + "\\n"); } catch {} };
export const SpikePlugin = async (ctx) => {
  log("PLUGIN_INIT ctxKeys=" + Object.keys(ctx || {}).join(","));
  return {
    "tool.execute.before": async (input, output) => {
      log("BEFORE input=" + JSON.stringify(input));
    },
    tool: {
      archie_ping: tool({
        description: "Spike ping tool. Call this once.",
        args: { msg: tool.schema.string().describe("any short string") },
        async execute(args, tctx) {
          log("EXECUTE args=" + JSON.stringify(args) + " tctxKeys=" + Object.keys(tctx || {}).join(",") + " tctx=" + JSON.stringify(tctx));
          try {
            const r = await fetch("http://127.0.0.1:${stubPort}/tool", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ from: "archie_ping", args, tctx }),
            });
            const j = await r.json();
            log("FETCH_OK " + JSON.stringify(j));
            return "pong:" + JSON.stringify(j);
          } catch (e) {
            log("FETCH_ERR " + String(e));
            return "fetch-failed";
          }
        },
      }),
    },
  };
};
`;
  writeFileSync(join(pluginsDir, 'spike.ts'), plugin);

  // server picks up <cwd>/.opencode/plugins/ — chdir into the project dir
  process.chdir(projectDir);

  const { client, server } = await createOpencode({
    port: 0,
    config: {
      model: MODEL, // (5) does the top-level config model get used?
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' }, // (6)
    },
  });

  try {
    const created = await client.session.create({ body: { title: 'spike' } });
    const sid = (created as any)?.data?.id;
    console.log('SESSION_ID', sid);

    // Prompt WITHOUT a model in the body — rely on config.model (routing test).
    const res = await client.session.prompt({
      path: { id: sid },
      body: {
        parts: [{ type: 'text', text: "Call the archie_ping tool once with msg='hi', then reply with the single word done." }],
      } as any,
    });

    const info = (res as any)?.data?.info ?? (res as any)?.data;
    console.log('ASSISTANT modelID=', info?.modelID, 'providerID=', info?.providerID, 'error=', JSON.stringify(info?.error));
    const parts = (res as any)?.data?.parts ?? [];
    const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
    console.log('ASSISTANT_TEXT', JSON.stringify(text));

    console.log('--- CAPTURE (plugin-side) ---');
    console.log(existsSync(captureFile) ? readFileSync(captureFile, 'utf8') : '(no capture)');
    console.log('--- STUB HITS ---');
    console.log(JSON.stringify(hits, null, 2));
  } finally {
    try { server.close(); } catch {}
    stub.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('SPIKE_ERROR', e); process.exit(1); });
