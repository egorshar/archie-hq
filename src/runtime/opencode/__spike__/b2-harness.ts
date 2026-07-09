/**
 * P2-B.2 Task-1 spike (throwaway). Decides the read-only enforcement mechanism.
 * Tests, against a real embedded opencode server, TWO approaches to blocking
 * opencode's BUILT-IN edit/bash tools per-session:
 *   M1) a plugin `tool.execute.before` hook that throws for edit/bash/write
 *   M2) per-role `config.agent.<name>.permission` ({edit:'deny',bash:'deny'})
 *       selected via `body.agent`, vs an allow agent
 * For each: does the built-in edit actually get BLOCKED (target file unchanged)?
 * How does the block surface to the model? Does body.agent selection work?
 *
 * Run: npx tsx src/runtime/opencode/__spike__/b2-harness.ts
 * Requires: opencode CLI on PATH + authed provider (OpenRouter) locally.
 */
import { createOpencode } from '@opencode-ai/sdk';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODEL = process.env.SPIKE_MODEL || 'openrouter/anthropic/claude-haiku-4.5';
const SENTINEL = 'ORIGINAL_CONTENT_DO_NOT_CHANGE';

async function main() {
  const projectDir = join(tmpdir(), 'archie-oc-b2spike');
  rmSync(projectDir, { recursive: true, force: true });
  const pluginsDir = join(projectDir, '.opencode', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const captureFile = join(projectDir, 'capture.log');
  writeFileSync(captureFile, '');
  const targetFile = join(projectDir, 'target.txt');

  // M1 plugin: log every tool.execute.before and THROW for write-ish built-ins.
  const plugin = `
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(captureFile)};
const log = (m) => { try { appendFileSync(LOG, m + "\\n"); } catch {} };
const BLOCK = new Set(["edit","write","bash","patch","multiedit","apply_patch"]);
export const RoGuard = async (ctx) => ({
  "tool.execute.before": async (input, output) => {
    log("BEFORE tool=" + input.tool + " sessionID=" + input.sessionID);
    // Only enforce for the M1 session (title marks it) — but we can't see the
    // session title here, so M1 test uses a dedicated server instance below.
    if (globalThis.__RO_ENFORCE__ && BLOCK.has(input.tool)) {
      log("BLOCKED " + input.tool);
      throw new Error("read-only mode: " + input.tool + " is not permitted");
    }
  },
});
`;
  writeFileSync(join(pluginsDir, 'roguard.ts'), plugin);
  process.chdir(projectDir);

  const results: Record<string, unknown> = {};

  // ---- M1: guard blocks built-in edit (enforce flag ON) ----
  writeFileSync(targetFile, SENTINEL + '\n');
  // The plugin reads globalThis.__RO_ENFORCE__ inside the SERVER process, which
  // we can't set from here — so instead bake enforcement ON in the plugin for
  // the M1 run and OFF for a control. Simplest: two servers. Run M1 first with
  // an always-enforce plugin.
  writeFileSync(
    join(pluginsDir, 'roguard.ts'),
    plugin.replace('globalThis.__RO_ENFORCE__ && ', ''),
  );
  {
    const { client, server } = await createOpencode({
      port: 0,
      config: { model: MODEL, permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' } },
    });
    try {
      const s = await client.session.create({ body: { title: 'm1' } });
      const sid = (s as any)?.data?.id;
      await client.session.prompt({
        path: { id: sid },
        body: { parts: [{ type: 'text', text: `Use the edit tool to replace the text in ${targetFile} with the word CHANGED. Then say done.` }] } as any,
      });
      const after = readFileSync(targetFile, 'utf8');
      results.M1 = { fileUnchanged: after.includes(SENTINEL), after: after.trim().slice(0, 60) };
    } finally { try { server.close(); } catch {} }
  }

  // ---- M2: per-role agent permission (deny vs allow) via body.agent ----
  writeFileSync(join(pluginsDir, 'roguard.ts'), '// disabled for M2\nexport const Noop = async () => ({});\n');
  writeFileSync(targetFile, SENTINEL + '\n');
  {
    const { client, server } = await createOpencode({
      port: 0,
      config: {
        model: MODEL,
        permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
        agent: {
          'archie-ro': { permission: { edit: 'deny', bash: 'deny' } } as any,
          'archie-rw': { permission: { edit: 'allow', bash: 'allow' } } as any,
        },
      },
    });
    try {
      // deny agent
      const sRo = await client.session.create({ body: { title: 'm2-ro' } });
      const ro = await client.session.prompt({
        path: { id: (sRo as any)?.data?.id },
        body: { agent: 'archie-ro', parts: [{ type: 'text', text: `Use the edit tool to replace the text in ${targetFile} with the word CHANGED. Then say done.` }] } as any,
      });
      const afterRo = readFileSync(targetFile, 'utf8');
      results.M2_ro = {
        fileUnchanged: afterRo.includes(SENTINEL),
        modelID: (ro as any)?.data?.info?.modelID,
        error: (ro as any)?.data?.info?.error,
      };

      // allow agent
      const sRw = await client.session.create({ body: { title: 'm2-rw' } });
      await client.session.prompt({
        path: { id: (sRw as any)?.data?.id },
        body: { agent: 'archie-rw', parts: [{ type: 'text', text: `Use the edit tool to replace the text in ${targetFile} with the word CHANGED. Then say done.` }] } as any,
      });
      const afterRw = readFileSync(targetFile, 'utf8');
      results.M2_rw = { fileChanged: !afterRw.includes(SENTINEL), after: afterRw.trim().slice(0, 60) };
    } finally { try { server.close(); } catch {} }
  }

  console.log('=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('=== CAPTURE (M1 before-hook log) ===');
  try { console.log(readFileSync(captureFile, 'utf8')); } catch {}
}

main().then(() => process.exit(0)).catch((e) => { console.error('SPIKE_ERROR', e); process.exit(1); });
