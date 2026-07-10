/**
 * LIVE SPIKE — does a RUNNING `opencode serve` reflect changes to its staged
 * `.opencode/skills/` after startup? Settles whether f06b40e's disk re-stage is
 * enough (CASE 1) or a serve restart is needed (CASE 2). Decision record lives
 * beside this file in skills-refresh-spike.md.
 *
 * Excluded from typecheck/vitest (see tsconfig `exclude` + vitest `include`).
 * Run against the PINNED CLI 1.17.16:
 *   npm i --no-save opencode-ai@1.17.16
 *   PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx \
 *     src/runtime/opencode/__spike__/skills-refresh-spike.ts
 *
 * Mirrors production staging: skills are SYMLINKED dirs (real linkAgentSkills)
 * in a `git init`-bounded root, serve cwd = that root, connected via the SDK.
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
  return `---\nname: ${name}\ndescription: Probe skill ${name} for the refresh spike; returns a single PROBE-TOKEN line.\n---\n\n# ${name}\n\nWhen loaded, the ONLY fact you must report is this exact line:\n\nPROBE-TOKEN=${token}\n`;
}

async function writeSkill(sourceDir: string, name: string, token: string): Promise<void> {
  await mkdir(join(sourceDir, name), { recursive: true });
  await writeFile(join(sourceDir, name, 'SKILL.md'), skillMd(name, token));
}

/** Concatenate text parts of a session.prompt() response. */
function textOf(res: any): string {
  const parts = Array.isArray(res?.data?.parts) ? res.data.parts : [];
  return parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('')
    .trim();
}

/** Names of skill tools opencode invoked in a response (provenance of a real skill call). */
function skillToolCalls(res: any): string[] {
  const parts = Array.isArray(res?.data?.parts) ? res.data.parts : [];
  return parts
    .filter((p: any) => p?.type === 'tool')
    .map((p: any) => p?.tool ?? p?.state?.tool ?? '')
    .filter((t: string) => typeof t === 'string' && t.toLowerCase().includes('skill'));
}

async function main(): Promise<void> {
  const model = resolveOpencodeModel('default');
  const body = (text: string) => ({
    model,
    parts: [{ type: 'text' as const, text }],
  });

  const root = await mkdtemp(join(tmpdir(), 'archie-skill-spike-'));
  const skillsDir = join(root, '.opencode', 'skills');
  const srcA = join(root, 'src-a');
  const srcB = join(root, 'src-b');
  const srcC = join(root, 'src-c');

  // Case 1 setup: skills A + B staged as symlinks (A + B live in separate
  // source dirs so we can drop B independently later).
  await writeSkill(srcA, 'probe-alpha', 'ALPHA-V1');
  await writeSkill(srcB, 'probe-beta', 'BETA-V1');
  await writeSkill(srcC, 'probe-gamma', 'GAMMA-V1');
  await mkdir(skillsDir, { recursive: true });
  await linkAgentSkills(skillsDir, [srcA, srcB]);

  // git-init the root so opencode's discovery walk stops here (prod parity).
  await execFileAsync('git', ['init', '-q'], { cwd: root });

  const log: string[] = [];
  const record = (line: string) => { log.push(line); console.log(line); };
  record(`# opencode skills-refresh spike — CLI ${process.env.__CLI_VERSION__ ?? '(see runner)'}`);
  record(`model route: ${model.providerID}/${model.modelID}`);
  record(`serve root: ${root}`);

  const server = await startEmbeddedServer({
    cwd: root,
    config: {
      model: `${model.providerID}/${model.modelID}`,
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
    },
    timeoutMs: 30000,
  });
  // The started server's client IS a `createOpencodeClient({ baseUrl })` handle
  // (embedded-server.ts) — the documented factory, connected to the real url.
  const c = server.client;

  const LIST_PROMPT =
    'Use the `skill` tool to discover the skills available to you. Then reply with ONLY a ' +
    'comma-separated list of the EXACT skill names it exposes (the frontmatter `name` values). No prose.';
  const loadPrompt = (name: string) =>
    `Use the \`skill\` tool to load the skill named exactly \`${name}\`. That skill's SKILL.md contains one ` +
    `line beginning \`PROBE-TOKEN=\`. Reply with ONLY that exact line. If no such skill exists or it cannot ` +
    `be loaded, reply with ONLY \`LOAD-ERROR: <the error>\`.`;

  async function freshSession(title: string): Promise<string> {
    const s = await c.session.create({ body: { title } });
    const id = (s as any)?.data?.id;
    if (!id) throw new Error(`session.create returned no id (${title})`);
    return id;
  }
  async function ask(sessionId: string, text: string): Promise<any> {
    return c.session.prompt({ path: { id: sessionId }, body: body(text) as any });
  }

  try {
    // ---- CASE 1: baseline — both listed and loadable ----
    record('\n## CASE 1 — baseline (A + B staged)');
    {
      const s = await freshSession('case1-list');
      const list = await ask(s, LIST_PROMPT);
      record(`list → text: ${JSON.stringify(textOf(list))}`);
      record(`list → skill tool calls: ${JSON.stringify(skillToolCalls(list))}`);
      const s2 = await freshSession('case1-loadA');
      const loadA = await ask(s2, loadPrompt('probe-alpha'));
      record(`load A → text: ${JSON.stringify(textOf(loadA))} (expect ALPHA-V1)`);
      record(`load A → skill tool calls: ${JSON.stringify(skillToolCalls(loadA))}`);
      const s3 = await freshSession('case1-loadB');
      const loadB = await ask(s3, loadPrompt('probe-beta'));
      record(`load B → text: ${JSON.stringify(textOf(loadB))} (expect BETA-V1)`);
    }

    // ---- CASE 2: MODIFY A's content behind its existing symlink ----
    record('\n## CASE 2 — modify A content behind the symlink (V1 → V2)');
    await writeFile(join(srcA, 'probe-alpha', 'SKILL.md'), skillMd('probe-alpha', 'ALPHA-V2'));
    {
      // (a) fresh session, A never loaded in it before — first-ever load in-session.
      const sFresh = await freshSession('case2-fresh');
      const loadFresh = await ask(sFresh, loadPrompt('probe-alpha'));
      record(`modify → fresh session load A → text: ${JSON.stringify(textOf(loadFresh))} (V2=fresh, V1=stale)`);

      // (b) same session, load A a SECOND time (content-cache within a session).
      const loadAgain = await ask(sFresh, 'Load `probe-alpha` again with the `skill` tool and reply ONLY the PROBE-TOKEN line.');
      record(`modify → same-session RE-load A → text: ${JSON.stringify(textOf(loadAgain))} (content-cache check)`);
    }

    // ---- CASE 3: ADD skill C (re-run staging) ----
    record('\n## CASE 3 — add skill C (re-stage A + B + C)');
    await linkAgentSkills(skillsDir, [srcA, srcB, srcC]);
    {
      const sList = await freshSession('case3-list');
      const list = await ask(sList, LIST_PROMPT);
      record(`add C → list → text: ${JSON.stringify(textOf(list))} (expect gamma present)`);
      const sLoad = await freshSession('case3-loadC');
      const loadC = await ask(sLoad, loadPrompt('probe-gamma'));
      record(`add C → load C → text: ${JSON.stringify(textOf(loadC))} (expect GAMMA-V1)`);
    }

    // ---- CASE 4: REMOVE skill B (re-run staging without B) ----
    record('\n## CASE 4 — remove skill B (re-stage A + C only)');
    await linkAgentSkills(skillsDir, [srcA, srcC]);
    {
      const sList = await freshSession('case4-list');
      const list = await ask(sList, LIST_PROMPT);
      record(`remove B → list → text: ${JSON.stringify(textOf(list))} (beta still present?)`);
      const sLoad = await freshSession('case4-loadB');
      const loadB = await ask(sLoad, loadPrompt('probe-beta'));
      record(`remove B → load B → text: ${JSON.stringify(textOf(loadB))} (error shape?)`);
    }

    // ---- CASE 5 (bonus): probe for any rescan API on the SDK client ----
    record('\n## CASE 5 — rescan-API probe (best-effort; do NOT build on undocumented endpoints)');
    try {
      const topLevel = Object.keys(c as any);
      record(`client top-level keys: ${JSON.stringify(topLevel)}`);
      const appKeys = (c as any).app ? Object.keys((c as any).app) : [];
      record(`client.app keys: ${JSON.stringify(appKeys)}`);
      const projectKeys = (c as any).project ? Object.keys((c as any).project) : [];
      record(`client.project keys: ${JSON.stringify(projectKeys)}`);
      // Try a documented-ish app init if present (records shape only).
      if ((c as any).app?.init) {
        const r = await (c as any).app.init({ body: {} }).catch((e: any) => ({ error: String(e) }));
        record(`app.init() → ${JSON.stringify(r?.data ?? r?.error ?? r).slice(0, 200)}`);
      } else {
        record('app.init() not present on client');
      }
    } catch (e) {
      record(`rescan probe error: ${e instanceof Error ? e.message : String(e)}`);
    }

    record('\n(spike complete — copy the observations above into skills-refresh-spike.md)');
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e);
  process.exit(1);
});
