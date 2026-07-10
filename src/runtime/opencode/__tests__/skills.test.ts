import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { rm, mkdir, readdir, stat, symlink, mkdtemp, readFile, readlink, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const linkAgentSkills = vi.fn(async () => {});
vi.mock('../../../agents/skill-linking.js', () => ({ linkAgentSkills }));

const getAllAgentDefs = vi.fn();
vi.mock('../../../agents/registry.js', () => ({ getAllAgentDefs }));

describe('stageOpencodeSkills', () => {
  beforeEach(() => {
    vi.resetModules();
    linkAgentSkills.mockReset();
    linkAgentSkills.mockResolvedValue(undefined);
    getAllAgentDefs.mockReset();
  });

  it('stages the deduped union of every agent\'s skill sources', async () => {
    getAllAgentDefs.mockReturnValue([
      { skillsPath: '/plugins/pm/skills', coreSkillsPath: '/core/skills' },
      { skillsPath: '/plugins/helper/skills', coreSkillsPath: '/core/skills' }, // core dup
      { skillsPath: undefined, coreSkillsPath: undefined },                     // no skills
      { skillsPath: '/plugins/pm/skills' },                                     // pm dup
    ]);
    const { stageOpencodeSkills } = await import('../skills.js');

    const n = await stageOpencodeSkills('/serve/.opencode/skills');

    expect(linkAgentSkills).toHaveBeenCalledTimes(1);
    const [dir, sources] = linkAgentSkills.mock.calls[0] as unknown as [string, string[]];
    expect(dir).toBe('/serve/.opencode/skills');
    expect([...sources].sort()).toEqual(['/core/skills', '/plugins/helper/skills', '/plugins/pm/skills']);
    expect(n).toBe(3);
  });

  it('stages nothing when no agent declares skills', async () => {
    getAllAgentDefs.mockReturnValue([{ skillsPath: undefined }, {}]);
    const { stageOpencodeSkills } = await import('../skills.js');

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
    linkAgentSkills.mockReset();

    // Implement real linkAgentSkills behavior for symlink creation
    linkAgentSkills.mockImplementation((async (agentSkillsDir: string, skillSources: string[]) => {
      await rm(agentSkillsDir, { recursive: true, force: true });
      await mkdir(agentSkillsDir, { recursive: true });
      for (const skillsPath of skillSources) {
        for (const skillEntry of await readdir(skillsPath, { withFileTypes: true })) {
          const entryPath = join(skillsPath, skillEntry.name);
          let isDir = skillEntry.isDirectory();
          if (!isDir && skillEntry.isSymbolicLink()) {
            isDir = await stat(entryPath).then((s) => s.isDirectory()).catch(() => false);
          }
          if (!isDir) continue;
          const target = join(agentSkillsDir, skillEntry.name);
          if (!existsSync(target)) {
            await symlink(entryPath, target);
          }
        }
      }
    }) as any);
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
