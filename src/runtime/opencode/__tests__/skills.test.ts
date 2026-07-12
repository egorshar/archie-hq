import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, readdir, mkdtemp, readFile, readlink, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Track every mkdtemp root so afterEach can remove it — otherwise these dirs
// accumulate under the OS temp dir across runs.
const tmpRoots: string[] = [];
async function tmpRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// Delegate to the REAL linkAgentSkills so these tests exercise production
// symlinking behavior, not a hand-copied reimplementation that could drift
// from src/agents/skill-linking.ts. Wrapping it in vi.fn() keeps it spyable
// for the call-shape assertions below.
vi.mock('../../../agents/skill-linking.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agents/skill-linking.js')>();
  return { ...actual, linkAgentSkills: vi.fn(actual.linkAgentSkills) };
});

// Per-agent tests with real file system behavior.
async function makeSkillSource(root: string, name: string, skills: string[]): Promise<string> {
  const dir = join(root, name);
  for (const s of skills) await mkdir(join(dir, s), { recursive: true });
  return dir;
}

describe('stageAgentSkills (per-agent, P3a §4)', () => {
  beforeEach(async () => {
    vi.resetModules();
    // Restore delegation to the REAL linkAgentSkills here so these tests
    // exercise production symlinking behavior end to end, regardless of run
    // order (vi.resetModules() clears the module-level mock's call history
    // but not its implementation override from a previous test file run).
    const { linkAgentSkills } = await import('../../../agents/skill-linking.js');
    const actual = await vi.importActual<typeof import('../../../agents/skill-linking.js')>(
      '../../../agents/skill-linking.js',
    );
    vi.mocked(linkAgentSkills).mockReset();
    vi.mocked(linkAgentSkills).mockImplementation(actual.linkAgentSkills);
  });

  it("links only the agent's own sources; plugin shadows core on a name collision", async () => {
    const { stageAgentSkills } = await import('../skills.js');
    const root = await tmpRoot('oc-skills-');
    const plugin = await makeSkillSource(root, 'plugin-skills', ['deploy', 'shared']);
    const core = await makeSkillSource(root, 'core-skills', ['review', 'shared']);
    const dest = join(root, 'dest');
    const n = await stageAgentSkills({ id: 'backend', skillsPath: plugin, coreSkillsPath: core } as any, dest);
    expect(n).toBe(2);
    expect((await readdir(dest)).sort()).toEqual(['deploy', 'review', 'shared']);
    expect(await readlink(join(dest, 'shared'))).toBe(join(plugin, 'shared')); // first source wins
  });

  it('stages an empty dir and returns 0 when the def declares no skills', async () => {
    const { stageAgentSkills } = await import('../skills.js');
    const root = await tmpRoot('oc-skills-');
    const dest = join(root, 'dest');
    const n = await stageAgentSkills({ id: 'pm-agent' } as any, dest);
    expect(n).toBe(0);
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('vendorBridgeDeps (P3b — offline bridge-plugin dependency)', () => {
  it('copies @opencode-ai/plugin (incl. its nested zod) into the node_modules dir', async () => {
    const { vendorBridgeDeps } = await import('../skills.js');
    const root = await tmpRoot('oc-vendor-');
    const nm = join(root, '.opencode', 'node_modules');
    await vendorBridgeDeps(nm);
    // The package the bridge plugin imports must resolve entirely offline: its
    // entry, the tool module, and its self-contained nested zod.
    expect(await readFile(join(nm, '@opencode-ai/plugin/package.json'), 'utf8')).toContain('"@opencode-ai/plugin"');
    expect(await readFile(join(nm, '@opencode-ai/plugin/dist/tool.js'), 'utf8')).toContain('zod');
    expect(await readFile(join(nm, '@opencode-ai/plugin/node_modules/zod/package.json'), 'utf8')).toContain('"zod"');
  });

  it('is idempotent — a second call over an already-vendored dir does not throw', async () => {
    const { vendorBridgeDeps } = await import('../skills.js');
    const root = await tmpRoot('oc-vendor-');
    const nm = join(root, '.opencode', 'node_modules');
    await vendorBridgeDeps(nm);
    await expect(vendorBridgeDeps(nm)).resolves.toBeUndefined();
    expect(await readFile(join(nm, '@opencode-ai/plugin/dist/index.js'), 'utf8')).toContain('tool.js');
  });
});

describe('excludeOpencodeFromGit', () => {
  it('appends .opencode/ to .git/info/exclude exactly once across repeat calls', async () => {
    const { excludeOpencodeFromGit } = await import('../skills.js');
    const clone = await tmpRoot('oc-clone-');
    await mkdir(join(clone, '.git', 'info'), { recursive: true });
    await writeFile(join(clone, '.git', 'info', 'exclude'), '# existing entries\nnode_modules/\n');
    await excludeOpencodeFromGit(clone);
    await excludeOpencodeFromGit(clone);
    const content = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(content.split('\n').filter((l) => l === '.opencode/')).toHaveLength(1);
    expect(content).toContain('node_modules/'); // prior entries preserved
  });

  it('creates .git/info/exclude when the file (or info dir) is missing', async () => {
    const { excludeOpencodeFromGit } = await import('../skills.js');
    const clone = await tmpRoot('oc-clone-');
    await mkdir(join(clone, '.git'), { recursive: true });
    await excludeOpencodeFromGit(clone);
    const content = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(content.split('\n')).toContain('.opencode/');
  });
});
