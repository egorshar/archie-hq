/**
 * THROWAWAY re-check — P3a Task 10 Step 1 (S2 skill-LOAD re-check). NOT part of
 * the resolved spike record; do not wire into build/test. Excluded from
 * typecheck/vitest by the same __spike__ dir convention as the sibling spikes.
 *
 * serve-topology-spike.ts's S2 confirmed skill *discovery* (list) sees a skill
 * staged into <clone>/.opencode/skills and stops at the clone's git-worktree
 * boundary, but left the skill *load* (body content) probe inconclusive — the
 * model didn't echo the PROBE-TOKEN line back in a `skill` tool-use turn (a
 * model-behavior artifact, not a discovery failure, per the spike record's
 * caveat). This script re-confirms body content is retrievable via TWO
 * independent checks:
 *
 *   (1) API check — the running serve child exposes skill content directly
 *       over HTTP on both its legacy `/skill` route and its v2 `/api/skill`
 *       route; each list entry carries a `content: string` field with the
 *       SKILL.md body verbatim (per the SDK's generated types, `SkillV2Info`/
 *       the legacy skills-response shape). If the PROBE-BODY-TOKEN line is
 *       present in that content, load is proven without depending on model
 *       echo fidelity at all. (The generated SDK client's own `v2.skill.list`
 *       binding came back empty against this CLI/SDK version — a client
 *       binding quirk, not a server gap — so this check hits the routes with
 *       plain `fetch` instead, which the SDK itself wraps.)
 *   (2) Prompt check — same as the original spike: ask the session to load
 *       the skill via the `skill` tool and repeat the PROBE-BODY-TOKEN line.
 *       A faithful echo is corroborating evidence of end-to-end tool-mediated
 *       load; a refusal/flake here does NOT invalidate check (1).
 *
 * Run against the PINNED CLI 1.17.16 (already installed in node_modules/.bin):
 *   PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx \
 *     src/runtime/opencode/__spike__/skill-load-recheck-spike.ts
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

const TOKEN = 'XYZZY-42';
const SKILL_NAME = 'probe-clone-body';

function skillMd(name: string, token: string): string {
  return `---\nname: ${name}\ndescription: Probe skill ${name} for the P3a Task-10 skill-load re-check; body carries a unique token line.\n---\n\n# ${name}\n\nWhen you load this skill, the ONE fact you must report back verbatim is this exact line:\n\nPROBE-BODY-TOKEN: ${token}\n`;
}

async function writeSkill(sourceDir: string, name: string, token: string): Promise<void> {
  await mkdir(join(sourceDir, name), { recursive: true });
  await writeFile(join(sourceDir, name, 'SKILL.md'), skillMd(name, token));
}

function textOf(res: any): string {
  const parts = Array.isArray(res?.data?.parts) ? res.data.parts : [];
  return parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
}

const log: string[] = [];
const record = (line: string) => { log.push(line); console.log(line); };

async function main(): Promise<void> {
  const model = resolveOpencodeModel('default');
  const modelStr = `${model.providerID}/${model.modelID}`;
  const body = (text: string) => ({ model, parts: [{ type: 'text' as const, text }] });
  const config = { model: modelStr, permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' } as const };
  record(`# skill-load re-check spike — model route ${modelStr}`);

  const parent = await mkdtemp(join(tmpdir(), 'archie-s2r-'));
  const clone = join(parent, 'repo-clone');
  await mkdir(clone, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: clone });

  const skillSrc = join(parent, 'skill-src');
  await writeSkill(skillSrc, SKILL_NAME, TOKEN);
  await mkdir(join(clone, '.opencode', 'skills'), { recursive: true });
  await linkAgentSkills(join(clone, '.opencode', 'skills'), [skillSrc]);

  const srv = await startEmbeddedServer({ cwd: clone, config, timeoutMs: 30000 });
  try {
    // ---- Check (1): API — fetch skill content directly over HTTP ----
    record('\n## Check (1) — API: does the serve expose skill BODY content directly?');
    let apiPass = false;
    try {
      const legacyRes = await fetch(`${srv.url}/skill?directory=${encodeURIComponent(clone)}`);
      const legacyList = await legacyRes.json() as any[];
      const legacyEntry = Array.isArray(legacyList) ? legacyList.find((s) => s?.name === SKILL_NAME) : undefined;
      record(`  GET /skill?directory=<clone> → names: ${JSON.stringify(Array.isArray(legacyList) ? legacyList.map((s) => s?.name) : legacyList)}`);
      if (legacyEntry) {
        const hasToken = typeof legacyEntry.content === 'string' && legacyEntry.content.includes(`PROBE-BODY-TOKEN: ${TOKEN}`);
        record(`  legacy entry content includes token? ${hasToken ? 'YES' : 'NO'} (content len=${legacyEntry.content?.length ?? 0})`);
        if (hasToken) apiPass = true;
      } else {
        record('  legacy entry NOT FOUND for probe skill name');
      }
    } catch (e) {
      record(`  GET /skill FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const v2Res = await fetch(`${srv.url}/api/skill?directory=${encodeURIComponent(clone)}`);
      const v2Body = await v2Res.json() as any;
      const v2List = Array.isArray(v2Body?.data) ? v2Body.data : [];
      const v2Entry = v2List.find((s: any) => s?.name === SKILL_NAME);
      record(`  GET /api/skill?directory=<clone> → names: ${JSON.stringify(v2List.map((s: any) => s?.name))}`);
      if (v2Entry) {
        const hasToken = typeof v2Entry.content === 'string' && v2Entry.content.includes(`PROBE-BODY-TOKEN: ${TOKEN}`);
        record(`  v2 entry content includes token? ${hasToken ? 'YES' : 'NO'} (content len=${v2Entry.content?.length ?? 0})`);
        if (hasToken) apiPass = true;
      } else {
        record('  v2 entry NOT FOUND for probe skill name');
      }
    } catch (e) {
      record(`  GET /api/skill FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    record(`  Check (1) verdict: ${apiPass ? 'PASS — body content retrievable over HTTP' : 'FAIL — no API surface returned the token'}`);

    // ---- Check (2): prompt — model echoes the token via the skill tool ----
    record('\n## Check (2) — prompt: model uses `skill` tool to load and echoes PROBE-BODY-TOKEN?');
    const session = await srv.client.session.create({ body: { title: 's2-recheck-load' } });
    const sid = (session as any)?.data?.id;
    const loadRes = await srv.client.session.prompt({ path: { id: sid }, body: body(
      `Use the \`skill\` tool to load the skill named exactly \`${SKILL_NAME}\`. Then reply with ONLY the exact PROBE-BODY-TOKEN line from that skill's body, verbatim, or LOAD-ERROR: <err> if you cannot load it.`) as any });
    const t = textOf(loadRes);
    record(`  reply → ${JSON.stringify(t)}`);
    const promptPass = t.includes(`PROBE-BODY-TOKEN: ${TOKEN}`) || t.includes(TOKEN);
    record(`  Check (2) verdict: ${promptPass ? 'PASS — model echoed the token' : 'FAIL/INCONCLUSIVE — token not echoed'}`);

    record(`\n## Overall: ${apiPass || promptPass ? 'PASS' : 'FAIL'} (API=${apiPass ? 'PASS' : 'FAIL'}, prompt=${promptPass ? 'PASS' : 'FAIL'})`);
  } finally {
    srv.close();
  }

  await rm(parent, { recursive: true, force: true }).catch(() => {});
  record('\n(re-check complete)');
}

main().catch((e) => { console.error('SPIKE FAILED:', e); process.exit(1); });
