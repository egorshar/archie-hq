/**
 * Per-runtime prompt vocabulary (spec §3.3 item 5). Agent prompts reference file
 * tools and skills by name; the Claude SDK exposes `Read`/`Grep`/… and a native
 * `Skill` tool, while opencode exposes `read`/`grep`/… and has no Skill tool
 * (capabilities.skills = false). These vars let one prompt file render correctly
 * on either runtime via the existing {{VAR}} loader. The `claude` values MUST
 * reproduce the prompts' previous hardcoded text byte-for-byte (regression).
 *
 * MECHANICAL ONLY: this makes prompts stop *assuming* Claude tooling. It does
 * not add a read_skill tool (later) and does not aim to fix live model-behavior
 * symptoms (double-post / idle-completion) — see the P2-C spec §2.
 */
export type RuntimeKind = 'claude' | 'opencode';

// Copied verbatim from prompts/pm-agent.md's pre-change Skill-tool instruction
// block — do not reword; the claude render must stay byte-identical.
const CLAUDE_SKILL_GUIDANCE =
  'You have domain-specific skills available via the `Skill` tool. Before delegating to any team member, you MUST load the relevant skill first — it contains the workflow, decision framework, and coordination patterns for that domain. Never delegate without first loading and reading the skill. If you\'re unsure which skill applies, list available skills by calling the `Skill` tool.';

const OPENCODE_SKILL_GUIDANCE =
  'Domain-specific guidance for your team members is provided in your context (AGENTS.md and the task briefing). Consult it before delegating so you apply each domain\'s workflow and coordination patterns. There is no separate skill-loading step.';

export function runtimePromptVars(kind: RuntimeKind): Record<string, string> {
  const claude = kind === 'claude';
  return {
    TOOL_READ: claude ? 'Read' : 'read',
    TOOL_GREP: claude ? 'Grep' : 'grep',
    TOOL_GLOB: claude ? 'Glob' : 'glob',
    TOOL_EDIT: claude ? 'Edit' : 'edit',
    TOOL_WRITE: claude ? 'Write' : 'write',
    TOOL_BASH: claude ? 'Bash' : 'bash',
    SKILL_GUIDANCE: claude ? CLAUDE_SKILL_GUIDANCE : OPENCODE_SKILL_GUIDANCE,
  };
}
