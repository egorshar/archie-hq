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

  it('opencode uses lowercase tool names and the lowercase `skill`-tool guidance', () => {
    const v = runtimePromptVars('opencode');
    expect(v.TOOL_READ).toBe('read');
    expect(v.TOOL_GREP).toBe('grep');
    expect(v.TOOL_BASH).toBe('bash');
    // opencode's native tool is lowercase `skill`; Claude's capital `Skill` must not leak.
    expect(v.SKILL_GUIDANCE).toContain('`skill` tool');
    expect(v.SKILL_GUIDANCE).not.toMatch(/`Skill`/);
  });
});

describe('claude-render byte-identical regression', () => {
  it('claude render of pm-agent still contains the exact Skill-tool instructions (all 4 templated clauses)', async () => {
    const out = await loadPrompt('pm-agent', {
      ...runtimePromptVars('claude'),
      TEAM_LIST: '',
      TEAM_EXPERTISE: '',
      PM_INTEGRATIONS: '',
    });
    // Line-19 guidance paragraph (Task 4 original scope).
    expect(out).toContain(
      'You have domain-specific skills available via the `Skill` tool. Before delegating to any team member, you MUST load the relevant skill first — it contains the workflow, decision framework, and coordination patterns for that domain. Never delegate without first loading and reading the skill. If you\'re unsure which skill applies, list available skills by calling the `Skill` tool.'
    );
    // The three additional clause-level Skill-tool instructions (Task 4 fix).
    expect(out).toContain('- If NO: I must call `Skill` tool to load it before proceeding');
    expect(out).toContain('- Action: [Load skill via `Skill` tool / Already loaded, using workflow from it]');
    expect(out).toContain('- Load the relevant domain skill via `Skill` tool (e.g. engineering, marketing)');
    // Completion-guidance block: claude keeps the verbatim original (incl. the
    // "confirm completion" line the opencode variant drops).
    expect(out).toContain('**When to include a message with report_completion** (user-facing milestones):');
    expect(out).toContain('- Work completed (confirm completion)');
    expect(out).toContain('**When to omit the message** (internal transitions):');
    expect(out).not.toContain('{{');
  });

  it('opencode render of pm-agent references the lowercase `skill` tool, not Claude\'s `Skill`', async () => {
    const out = await loadPrompt('pm-agent', {
      ...runtimePromptVars('opencode'),
      TEAM_LIST: '',
      TEAM_EXPERTISE: '',
      PM_INTEGRATIONS: '',
    });
    expect(out).not.toMatch(/`Skill`/);        // Claude's capital tool name must not leak
    expect(out).toContain('`skill` tool');      // opencode's lowercase native tool
    expect(out).not.toContain('{{');
  });

  it('opencode render of pm-agent tells the PM it cannot execute commands / must not request edit mode for them', async () => {
    const out = await loadPrompt('pm-agent', {
      ...runtimePromptVars('opencode'),
      TEAM_LIST: '',
      TEAM_EXPERTISE: '',
      PM_INTEGRATIONS: '',
    });
    expect(out).toContain('You cannot run shell commands or scripts yourself');
    expect(out).toContain('edit mode does NOT grant you command execution');
    expect(out).not.toContain('{{');
  });

  it('claude render of pm-agent has NO command-execution note (byte-identical: empty var)', async () => {
    const out = await loadPrompt('pm-agent', {
      ...runtimePromptVars('claude'),
      TEAM_LIST: '',
      TEAM_EXPERTISE: '',
      PM_INTEGRATIONS: '',
    });
    expect(out).not.toContain('You cannot run shell commands or scripts yourself');
    expect(out).not.toContain('{{');
  });

  it('opencode render of pm-agent enforces single-delivery completion (no redundant confirm)', async () => {
    const out = await loadPrompt('pm-agent', {
      ...runtimePromptVars('opencode'),
      TEAM_LIST: '',
      TEAM_EXPERTISE: '',
      PM_INTEGRATIONS: '',
    });
    expect(out).toContain('**Deliver your answer exactly once, then finish.**');
    expect(out).toContain('`report_completion()` with NO message');
    // The "confirm completion" invitation that induced the double-post is gone.
    expect(out).not.toContain('- Work completed (confirm completion)');
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

  it('opencode render of plugin-agent references the lowercase `skill` tool, not `Skill`', async () => {
    const out = await loadPrompt('plugin-agent', runtimePromptVars('opencode'));
    expect(out).not.toMatch(/`Skill`/);
    expect(out).toContain('- **skill** — Load and use domain-specific skills from your skills directory');
    expect(out).not.toContain('{{');
  });
});
