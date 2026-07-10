/**
 * linkAgentSkills — the per-task `.claude/skills` symlink builder extracted from
 * setupAgentWorkspace. Regression coverage for the 2026-07-10 crash: a DANGLING
 * skill symlink (left by a different-workdir process — a container whose
 * absolute `/workdir/...` paths don't resolve on the host) slipped the
 * `existsSync` guard (existsSync FOLLOWS the link → false for a dangling one)
 * and made `symlink()` throw EEXIST, which, uncaught in the recovery path,
 * crashed the daemon.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, rm, readlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { linkAgentSkills } from '../skill-linking.js';

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'las-')); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

async function makeSkillSource(dir: string, names: string[]) {
  await mkdir(dir, { recursive: true });
  for (const n of names) {
    await mkdir(join(dir, n), { recursive: true });
    await writeFile(join(dir, n, 'SKILL.md'), n);
  }
}

describe('linkAgentSkills', () => {
  it('heals a DANGLING symlink at the target instead of throwing EEXIST', async () => {
    const src = join(tmp, 'plugin-skills');
    await makeSkillSource(src, ['alpha']);
    const skillsDir = join(tmp, 'agent', '.claude', 'skills');
    await mkdir(skillsDir, { recursive: true });
    // Plant a dangling symlink (points at a non-existent absolute path, like a
    // container's /workdir/... on the host) at the target name.
    await symlink('/nonexistent/workdir/plugins/pm/skills/alpha', join(skillsDir, 'alpha'));
    expect(existsSync(join(skillsDir, 'alpha'))).toBe(false); // dangling → existsSync follows → false

    await expect(linkAgentSkills(skillsDir, [src])).resolves.toBeUndefined();

    expect(existsSync(join(skillsDir, 'alpha'))).toBe(true); // now a valid link
    expect(await readlink(join(skillsDir, 'alpha'))).toBe(join(src, 'alpha'));
  });

  it('plugin source shadows a core source of the same name (first source wins)', async () => {
    const plugin = join(tmp, 'plugin');
    await makeSkillSource(plugin, ['shared', 'p-only']);
    const core = join(tmp, 'core');
    await makeSkillSource(core, ['shared', 'c-only']);
    const skillsDir = join(tmp, 'agent', '.claude', 'skills');

    await linkAgentSkills(skillsDir, [plugin, core]); // plugin first

    expect(await readlink(join(skillsDir, 'shared'))).toBe(join(plugin, 'shared')); // plugin shadows core
    expect(existsSync(join(skillsDir, 'p-only'))).toBe(true);
    expect(existsSync(join(skillsDir, 'c-only'))).toBe(true);
  });

  it('is idempotent across repeated spawns (no EEXIST on the second call)', async () => {
    const src = join(tmp, 's');
    await makeSkillSource(src, ['x']);
    const skillsDir = join(tmp, 'agent', '.claude', 'skills');
    await linkAgentSkills(skillsDir, [src]);
    await expect(linkAgentSkills(skillsDir, [src])).resolves.toBeUndefined();
    expect(await readlink(join(skillsDir, 'x'))).toBe(join(src, 'x'));
  });
});
