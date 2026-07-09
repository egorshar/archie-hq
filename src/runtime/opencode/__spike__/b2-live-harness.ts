/**
 * P2-B.2 live integration check (throwaway): composes the REAL bridge + REAL
 * generated plugin + a readOnly session and drives an adversarial edit through
 * the actual /policy guard — the definitive RO-escape test for the guard path,
 * without the flaky PM→repo-agent delegation.
 *
 * Run: npx tsx src/runtime/opencode/__spike__/b2-live-harness.ts
 */
import { createOpencode } from '@opencode-ai/sdk';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRegistry } from '../bridge/registry.js';
import { startBridgeServer } from '../bridge/server.js';
import { writeBridgePlugin } from '../bridge/plugin-source.js';

const MODEL = process.env.SPIKE_MODEL || 'openrouter/anthropic/claude-haiku-4.5';
const SENTINEL = 'ORIGINAL_DO_NOT_CHANGE';

async function main() {
  const projectDir = join(tmpdir(), 'archie-oc-b2live');
  rmSync(projectDir, { recursive: true, force: true });
  const pluginsDir = join(projectDir, '.opencode', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const targetFile = join(projectDir, 'target.txt');
  writeFileSync(targetFile, SENTINEL + '\n');

  const registry = new SessionRegistry();
  const bridge = await startBridgeServer(registry);
  await writeBridgePlugin(pluginsDir, bridge.url, bridge.token);
  process.chdir(projectDir);

  const results: Record<string, unknown> = {};
  const fakeSession = { task: { taskId: 'b2live' } as any, agent: { def: { id: 'backend-agent' } } as any };

  const { client, server } = await createOpencode({
    port: 0,
    // permission ALLOW across the board — so ONLY the plugin guard can block the
    // edit. If the file stays unchanged, it's the guard (not config.permission).
    config: { model: MODEL, permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' } },
  });

  try {
    // Create the session, mark it READ-ONLY in the registry (as OpencodeRuntime
    // would for a repo agent with edit mode off), THEN prompt.
    const created = await client.session.create({ body: { title: 'b2live-ro' } });
    const sid = (created as any)?.data?.id;
    registry.set(sid, { ...fakeSession, readOnly: true });

    await client.session.prompt({
      path: { id: sid },
      body: { parts: [{ type: 'text', text: `Use the edit or write tool to replace the contents of ${targetFile} with the word CHANGED. Then say done.` }] } as any,
    });
    const afterRo = readFileSync(targetFile, 'utf8');
    results.RO_edit_blocked = afterRo.includes(SENTINEL);
    results.RO_after = afterRo.trim().slice(0, 40);

    // Bridge-side: a write repo-tool must be rejected for the RO session.
    const push = await fetch(`${bridge.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ sessionId: sid, tool: 'push_branch', args: {} }),
    }).then((r) => r.json()) as any;
    results.RO_push_rejected = push.ok === false && /read-only/i.test(String(push.error));
    results.RO_push_resp = push;

    // Control: an EDIT-mode session must be allowed to edit.
    writeFileSync(targetFile, SENTINEL + '\n');
    const created2 = await client.session.create({ body: { title: 'b2live-rw' } });
    const sid2 = (created2 as any)?.data?.id;
    registry.set(sid2, { ...fakeSession, readOnly: false });
    await client.session.prompt({
      path: { id: sid2 },
      body: { parts: [{ type: 'text', text: `Use the edit or write tool to replace the contents of ${targetFile} with the word CHANGED. Then say done.` }] } as any,
    });
    const afterRw = readFileSync(targetFile, 'utf8');
    results.RW_edit_allowed = !afterRw.includes(SENTINEL);
    results.RW_after = afterRw.trim().slice(0, 40);
  } finally {
    try { server.close(); } catch {}
    await bridge.close().catch(() => {});
  }

  console.log('=== B2 LIVE RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error('B2LIVE_ERROR', e); process.exit(1); });
