/**
 * LIVE SPIKE — P3a serve-topology branch points (S1, S2). Excluded from
 * typecheck/vitest (tsconfig `exclude` + vitest `include`). Decision record:
 * skills-topology findings go in serve-topology-spike.md beside this file.
 *
 * Run against the PINNED CLI 1.17.16:
 *   npm i --no-save opencode-ai@1.17.16
 *   PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx \
 *     src/runtime/opencode/__spike__/serve-topology-spike.ts
 *
 * S1: does a session survive a serve-child restart? Create a session on child #1
 *     (cwd=root), establish in-session memory, kill #1, start #2 with the SAME
 *     root, and prompt the OLD sessionID. 404 (NotFoundError) → context-free
 *     recycle design; normal reply → RESUME (keep roots for task lifetime).
 * S2: with cwd = a git-worktree "clone" and skills staged in <clone>/.opencode/
 *     skills, does discovery see exactly those skills and stop at the worktree
 *     boundary (a decoy in a non-git PARENT dir must NOT appear)?
 */
import 'dotenv/config';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { linkAgentSkills } from '../../../agents/skill-linking.js';
import { startEmbeddedServer } from '../embedded-server.js';
import { resolveOpencodeModel } from '../model.js';

const execFileAsync = promisify(execFile);

function skillMd(name: string, token: string): string {
  return `---\nname: ${name}\ndescription: Probe skill ${name} for the serve-topology spike; returns a single PROBE-TOKEN line.\n---\n\n# ${name}\n\nWhen loaded, the ONLY fact you must report is this exact line:\n\nPROBE-TOKEN=${token}\n`;
}
async function writeSkill(sourceDir: string, name: string, token: string): Promise<void> {
  await mkdir(join(sourceDir, name), { recursive: true });
  await writeFile(join(sourceDir, name, 'SKILL.md'), skillMd(name, token));
}
function textOf(res: any): string {
  const parts = Array.isArray(res?.data?.parts) ? res.data.parts : [];
  return parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
}
/** True when a prompt result carries opencode's session-not-found signal. */
function isNotFound(res: any): boolean {
  const name = res?.error?.name ?? res?.data?.info?.error?.name;
  const msg = res?.error?.data?.message ?? res?.error?.message ?? '';
  return name === 'NotFoundError' || /not found/i.test(String(msg));
}

const log: string[] = [];
const record = (line: string) => { log.push(line); console.log(line); };

async function main(): Promise<void> {
  const model = resolveOpencodeModel('default');
  const modelStr = `${model.providerID}/${model.modelID}`;
  const body = (text: string) => ({ model, parts: [{ type: 'text' as const, text }] });
  const config = { model: modelStr, permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' } as const };
  record(`# serve-topology spike — model route ${modelStr}`);

  // ==================== S1 — session persistence across restart ====================
  record('\n## S1 — session survives serve-child restart?');
  const s1root = await mkdtemp(join(tmpdir(), 'archie-s1-'));
  await execFileAsync('git', ['init', '-q'], { cwd: s1root });
  const CODEWORD = 'ZEBRA-7';

  const srv1 = await startEmbeddedServer({ cwd: s1root, config, timeoutMs: 30000 });
  let oldSessionId = '';
  try {
    const created = await srv1.client.session.create({ body: { title: 's1' } });
    oldSessionId = (created as any)?.data?.id;
    record(`created session ${oldSessionId} on child #1 (root ${s1root})`);
    const set = await srv1.client.session.prompt({ path: { id: oldSessionId }, body: body(
      `Remember this fact for later: the secret codeword is ${CODEWORD}. Reply with only the word OK.`) as any });
    record(`child#1 establish → ${JSON.stringify(textOf(set)).slice(0, 120)}`);
  } finally {
    srv1.close();
  }
  // Give the child a moment to fully exit + flush any storage.
  await new Promise((r) => setTimeout(r, 1500));

  // (a) restart with the SAME root
  const srv2 = await startEmbeddedServer({ cwd: s1root, config, timeoutMs: 30000 });
  try {
    const recall = await srv2.client.session.prompt({ path: { id: oldSessionId }, body: body(
      `What is the secret codeword I told you earlier? Reply with ONLY the codeword, or NONE if you do not know.`) as any });
    if (isNotFound(recall)) {
      record(`SAME-root restart → OLD sessionID = 404 NotFoundError → CASE 404 (context-free recycle)`);
    } else {
      const t = textOf(recall);
      record(`SAME-root restart → OLD sessionID resumed. recall text: ${JSON.stringify(t).slice(0, 160)}`);
      record(`  context preserved? ${t.includes(CODEWORD) ? 'YES — CASE RESUME (codeword recalled)' : 'session existed but codeword NOT in reply (inspect)'}`);
    }
  } finally {
    srv2.close();
  }
  await new Promise((r) => setTimeout(r, 1000));

  // (b) restart with a DIFFERENT root — does project scoping (cwd) gate resume?
  const s1root2 = await mkdtemp(join(tmpdir(), 'archie-s1b-'));
  await execFileAsync('git', ['init', '-q'], { cwd: s1root2 });
  const srv3 = await startEmbeddedServer({ cwd: s1root2, config, timeoutMs: 30000 });
  try {
    const recall = await srv3.client.session.prompt({ path: { id: oldSessionId }, body: body(
      `What is the secret codeword? Reply ONLY the codeword or NONE.`) as any });
    record(`DIFFERENT-root restart → OLD sessionID ${isNotFound(recall) ? '= 404 (sessions are cwd/project-scoped)' : 'resumed (sessions are GLOBAL, not root-scoped): ' + JSON.stringify(textOf(recall)).slice(0,120)}`);
  } finally {
    srv3.close();
  }

  // ==================== S2 — cwd=clone skill discovery + boundary ====================
  record('\n## S2 — cwd=clone: discovery sees clone skills, stops at worktree boundary?');
  const parent = await mkdtemp(join(tmpdir(), 'archie-s2-'));       // NON-git parent (decoy lives here)
  const clone = join(parent, 'repo-clone');                         // git worktree (the agent clone)
  await mkdir(clone, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: clone });

  // Decoy skill in the parent's .opencode/skills (must NOT be discovered from the clone).
  const decoySrc = join(parent, 'decoy-src');
  await writeSkill(decoySrc, 'probe-decoy', 'DECOY');
  await mkdir(join(parent, '.opencode', 'skills'), { recursive: true });
  await linkAgentSkills(join(parent, '.opencode', 'skills'), [decoySrc]);

  // Real skill staged into the clone's own .opencode/skills.
  const cloneSkillSrc = join(parent, 'clone-src');
  await writeSkill(cloneSkillSrc, 'probe-clone', 'CLONE-V1');
  await mkdir(join(clone, '.opencode', 'skills'), { recursive: true });
  await linkAgentSkills(join(clone, '.opencode', 'skills'), [cloneSkillSrc]);

  const srv4 = await startEmbeddedServer({ cwd: clone, config, timeoutMs: 30000 });
  try {
    const list = await srv4.client.session.create({ body: { title: 's2-list' } });
    const sid = (list as any)?.data?.id;
    const res = await srv4.client.session.prompt({ path: { id: sid }, body: body(
      'Use the `skill` tool to discover your available skills. Reply with ONLY a comma-separated list of the exact skill names it exposes. No prose.') as any });
    const t = textOf(res);
    record(`clone list → ${JSON.stringify(t)}`);
    record(`  probe-clone present? ${/probe-clone/.test(t) ? 'YES' : 'NO'}; probe-decoy leaked? ${/probe-decoy/.test(t) ? 'YES (boundary FAILED)' : 'no (boundary held)'}`);
    const load = await srv4.client.session.create({ body: { title: 's2-load' } });
    const loadRes = await srv4.client.session.prompt({ path: { id: (load as any)?.data?.id }, body: body(
      'Use the `skill` tool to load the skill named exactly `probe-clone`. Reply with ONLY its PROBE-TOKEN= line, or LOAD-ERROR: <err>.') as any });
    record(`clone load probe-clone → ${JSON.stringify(textOf(loadRes)).slice(0, 120)} (expect CLONE-V1)`);
  } finally {
    srv4.close();
  }

  record('\n(spike complete — copy observations into serve-topology-spike.md)');

  // Cleanup
  await Promise.all([s1root, s1root2, parent].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

main().catch((e) => { console.error('SPIKE FAILED:', e); process.exit(1); });
