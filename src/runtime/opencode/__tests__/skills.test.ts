import { describe, it, expect, vi, beforeEach } from 'vitest';

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
