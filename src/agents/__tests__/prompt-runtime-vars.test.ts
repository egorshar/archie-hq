import { describe, it, expect } from 'vitest';
import { runtimePromptVars } from '../prompt-runtime-vars.js';
import { loadPrompt } from '../../utils/prompt-loader.js';

describe('runtimePromptVars', () => {
  it('claude uses capitalized tool names and the full Skill guidance', () => {
    const v = runtimePromptVars('claude');
    expect(v.TOOL_READ).toBe('Read');
    expect(v.TOOL_GREP).toBe('Grep');
    expect(v.TOOL_BASH).toBe('Bash');
    expect(v.SKILL_GUIDANCE).toContain('Skill');
  });

  it('opencode uses lowercase tool names and softened, Skill-tool-free guidance', () => {
    const v = runtimePromptVars('opencode');
    expect(v.TOOL_READ).toBe('read');
    expect(v.TOOL_GREP).toBe('grep');
    expect(v.TOOL_BASH).toBe('bash');
    expect(v.SKILL_GUIDANCE).not.toMatch(/`Skill` tool/);
  });
});

describe('claude-render byte-identical regression', () => {
  it('claude render of pm-agent still contains the exact Skill-tool instruction', async () => {
    const out = await loadPrompt('pm-agent', {
      ...runtimePromptVars('claude'),
      TEAM_LIST: '',
      TEAM_EXPERTISE: '',
      PM_INTEGRATIONS: '',
    });
    expect(out).toContain(
      'You have domain-specific skills available via the `Skill` tool. Before delegating to any team member, you MUST load the relevant skill first — it contains the workflow, decision framework, and coordination patterns for that domain. Never delegate without first loading and reading the skill. If you\'re unsure which skill applies, list available skills by calling the `Skill` tool.'
    );
    expect(out).not.toContain('{{');
  });

  it('claude render of agent-core still contains the exact Read/Write/Edit/tool phrases', async () => {
    const out = await loadPrompt('agent-core', {
      ...runtimePromptVars('claude'),
      AGENT_ID: 'x',
      AGENT_ROLE: 'y',
      EXPERTISE: 'z',
      PEER_LIST: '',
    });
    expect(out).toContain('Read incoming artifacts with the standard `Read` tool on the path the sender gave you.');
    expect(out).not.toContain('{{');
  });

  it('claude render of repo-agent still contains the exact tool phrases', async () => {
    const out = await loadPrompt('repo-agent', runtimePromptVars('claude'));
    expect(out).toContain(
      'you can investigate and explore the codebase using Read, Grep, Glob tools, and read-only git commands.'
    );
    expect(out).toContain('If Write and Edit tools are in your tool list → Edit Mode');
    expect(out).toContain('1. Make your code changes using Write/Edit tools');
    expect(out).not.toContain('{{');
  });

  it('claude render of plugin-agent still contains the exact tool bullet list', async () => {
    const out = await loadPrompt('plugin-agent', runtimePromptVars('claude'));
    expect(out).toContain('- **Read** — Read file contents');
    expect(out).toContain('- **Glob** — Search for files by pattern');
    expect(out).toContain('- **Grep** — Search file contents by regex');
    expect(out).toContain('- **Skill** — Load and use domain-specific skills from your skills directory');
    expect(out).not.toContain('{{');
  });
});
