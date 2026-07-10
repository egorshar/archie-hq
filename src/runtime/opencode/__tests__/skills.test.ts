import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, readdir, mkdtemp, readFile, readlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Delegate to the REAL linkAgentSkills so these tests exercise production
// symlinking behavior, not a hand-copied reimplementation that could drift
// from src/agents/skill-linking.ts. Wrapping it in vi.fn() keeps it spyable
// for the call-shape assertions below (stageOpencodeSkills tests override the
// implementation with a no-op since they use non-existent fixture paths).
vi.mock('../../../agents/skill-linking.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agents/skill-linking.js')>();
  return { ...actual, linkAgentSkills: vi.fn(actual.linkAgentSkills) };
});

const getAllAgentDefs = vi.fn();
vi.mock('../../../agents/registry.js', () => ({ getAllAgentDefs }));

describe('stageOpencodeSkills', () => {
  beforeEach(async () => {
    vi.resetModules();
    getAllAgentDefs.mockReset();
    const { linkAgentSkills } = await import('../../../agents/skill-linking.js');
    vi.mocked(linkAgentSkills).mockReset();
    vi.mocked(linkAgentSkills).mockResolvedValue(undefined);
  });

  it('stages the deduped union of every agent\'s skill sources', async () => {
    getAllAgentDefs.mockReturnValue([
      { skillsPath: '/plugins/pm/skills', coreSkillsPath: '/core/skills' },
      { skillsPath: '/plugins/helper/skills', coreSkillsPath: '/core/skills' }, // core dup
      { skillsPath: undefined, coreSkillsPath: undefined },                     // no skills
      { skillsPath: '/plugins/pm/skills' },                                     // pm dup
    ]);
    const { stageOpencodeSkills } = await import('../skills.js');
    const { linkAgentSkills } = await import('../../../agents/skill-linking.js');

    const n = await stageOpencodeSkills('/serve/.opencode/skills');

    expect(linkAgentSkills).toHaveBeenCalledTimes(1);
    const [dir, sources] = vi.mocked(linkAgentSkills).mock.calls[0] as unknown as [string, string[]];
    expect(dir).toBe('/serve/.opencode/skills');
    expect([...sources].sort()).toEqual(['/core/skills', '/plugins/helper/skills', '/plugins/pm/skills']);
    expect(n).toBe(3);
  });

  it('stages nothing when no agent declares skills', async () => {
    getAllAgentDefs.mockReturnValue([{ skillsPath: undefined }, {}]);
    const { stageOpencodeSkills } = await import('../skills.js');
    const { linkAgentSkills } = await import('../../../agents/skill-linking.js');

    const n = await stageOpencodeSkills('/serve/.opencode/skills');

    expect(n).toBe(0);
    expect(linkAgentSkills).toHaveBeenCalledWith('/serve/.opencode/skills', []);
  });
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
    // The stageOpencodeSkills tests above override the shared mock with a
    // no-op (their fixture paths don't exist on disk). Restore delegation to
    // the REAL linkAgentSkills here so these tests exercise production
    // symlinking behavior end to end, regardless of run order.
    const { linkAgentSkills } = await import('../../../agents/skill-linking.js');
    const actual = await vi.importActual<typeof import('../../../agents/skill-linking.js')>(
      '../../../agents/skill-linking.js',
    );
    vi.mocked(linkAgentSkills).mockReset();
    vi.mocked(linkAgentSkills).mockImplementation(actual.linkAgentSkills);
  });

  it("links only the agent's own sources; plugin shadows core on a name collision", async () => {
    const { stageAgentSkills } = await import('../skills.js');
    const root = await mkdtemp(join(tmpdir(), 'oc-skills-'));
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
    const root = await mkdtemp(join(tmpdir(), 'oc-skills-'));
    const dest = join(root, 'dest');
    const n = await stageAgentSkills({ id: 'pm-agent' } as any, dest);
    expect(n).toBe(0);
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('excludeOpencodeFromGit', () => {
  it('appends .opencode/ to .git/info/exclude exactly once across repeat calls', async () => {
    const { excludeOpencodeFromGit } = await import('../skills.js');
    const clone = await mkdtemp(join(tmpdir(), 'oc-clone-'));
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
    const clone = await mkdtemp(join(tmpdir(), 'oc-clone-'));
    await mkdir(join(clone, '.git'), { recursive: true });
    await excludeOpencodeFromGit(clone);
    const content = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(content.split('\n')).toContain('.opencode/');
  });
});
