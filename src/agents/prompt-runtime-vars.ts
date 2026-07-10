/**
 * Per-runtime prompt vocabulary (spec §3.3 item 5). Agent prompts reference file
 * tools and skills by name; the Claude SDK exposes `Read`/`Grep`/… and a native
 * `Skill` tool, while opencode exposes `read`/`grep`/… and has no Skill tool
 * (capabilities.skills = false). These vars let one prompt file render correctly
 * on either runtime via the existing {{VAR}} loader. The `claude` values MUST
 * reproduce the prompts' previous hardcoded text byte-for-byte (regression).
 *
 * Mostly MECHANICAL: the tool-name and Skill vars make prompts stop *assuming*
 * Claude tooling (they do not add a read_skill tool — later). The completion
 * guidance var (COMPLETION_MESSAGE_GUIDANCE) is the one behavioral entry: it
 * rewords the report_completion guidance for opencode to stop a weaker model
 * double-posting (answer via post_to_user + a redundant "task completed"
 * confirmation via report_completion). CLAUDE values stay byte-identical.
 */
export type RuntimeKind = 'claude' | 'opencode';

// Copied verbatim from prompts/pm-agent.md's pre-change Skill-tool instruction
// block — do not reword; the claude render must stay byte-identical.
const CLAUDE_SKILL_GUIDANCE =
  'You have domain-specific skills available via the `Skill` tool. Before delegating to any team member, you MUST load the relevant skill first — it contains the workflow, decision framework, and coordination patterns for that domain. Never delegate without first loading and reading the skill. If you\'re unsure which skill applies, list available skills by calling the `Skill` tool.';

const OPENCODE_SKILL_GUIDANCE =
  'Domain-specific guidance for your team members is provided in your context (AGENTS.md and the task briefing). Consult it before delegating so you apply each domain\'s workflow and coordination patterns. There is no separate skill-loading step.';

// Clause-level Skill-tool neutralization (design §4.4: "soften prompts that
// reference the `Skill` tool"). Each var covers one distinct grammatical context
// where a prompt tells the model to call the native `Skill` tool — which doesn't
// exist under opencode (capabilities.skills = false). A single paragraph var
// (SKILL_GUIDANCE) can't fit these mid-sentence/mid-checklist spots, so each gets
// its own clause. CLAUDE values are the EXACT pre-change text (byte-identical
// render); OPENCODE values are tool-free and point at the same in-context guidance
// as OPENCODE_SKILL_GUIDANCE.

// prompts/pm-agent.md — Skill Resolution reasoning checklist item.
const CLAUDE_SKILL_CHECK_ACTION = 'If NO: I must call `Skill` tool to load it before proceeding';
const OPENCODE_SKILL_CHECK_ACTION =
  'If NO: consult the domain guidance in my context (AGENTS.md and the task briefing) before proceeding';

// prompts/pm-agent.md — Skill Resolution analysis-template "Action" line.
const CLAUDE_SKILL_RESOLUTION_ACTION =
  'Action: [Load skill via `Skill` tool / Already loaded, using workflow from it]';
const OPENCODE_SKILL_RESOLUTION_ACTION =
  'Action: [Consult domain guidance in my context (AGENTS.md and the task briefing) / Already consulted, using its workflow]';

// prompts/pm-agent.md — "New task from Slack" decision-framework first step.
const CLAUDE_SKILL_DELEGATION_STEP = 'Load the relevant domain skill via `Skill` tool (e.g. engineering, marketing)';
const OPENCODE_SKILL_DELEGATION_STEP =
  'Consult the relevant domain guidance in your context (AGENTS.md and the task briefing; e.g. engineering, marketing)';

// prompts/plugin-agent.md — Available Tools bullet (text after the "- " marker).
const CLAUDE_SKILL_TOOL_BULLET = '**Skill** — Load and use domain-specific skills from your skills directory';
const OPENCODE_SKILL_TOOL_BULLET = 'Domain guidance is available in your context (AGENTS.md and the task briefing)';

// prompts/pm-agent.md — Task Completion Philosophy, the "when to include/omit a
// report_completion message" block. CLAUDE keeps the verbatim original. OPENCODE
// is reworded to enforce single delivery (answer once, then finish) and to drop
// the "Work completed (confirm completion)" line that invited a redundant
// "task completed" post on top of an already-posted answer — the double-post
// symptom observed live in the P2-C smoke.
const CLAUDE_COMPLETION_MESSAGE_GUIDANCE = `**When to include a message with report_completion** (user-facing milestones):

- Answering a question or providing status
- Deliverable ready (share the link)
- Work completed (confirm completion)
- Blocker encountered (explain what's blocking)

**When to omit the message** (internal transitions):

- After internal coordination steps that don't need user visibility`;

const OPENCODE_COMPLETION_MESSAGE_GUIDANCE = `**Deliver your answer exactly once, then finish.** Your final answer to the user is delivered by a SINGLE call — either \`report_completion(message: <your answer>)\` (answers and finishes in one step), or, if you already sent the answer with \`post_to_user\`, \`report_completion()\` with NO message. Never post a separate "done" / "task completed" confirmation after you have already delivered the substance — it is a duplicate the user does not need.

**Include a message with report_completion** only when it carries substance the user needs and you have not already posted it:

- Answering a question or providing status
- Deliverable ready (share the link)
- Blocker encountered (explain what's blocking)

**Omit the message** — call \`report_completion()\` silently — when:

- You already delivered the answer via \`post_to_user\` this turn
- After internal coordination steps that don't need user visibility`;

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
    SKILL_CHECK_ACTION: claude ? CLAUDE_SKILL_CHECK_ACTION : OPENCODE_SKILL_CHECK_ACTION,
    SKILL_RESOLUTION_ACTION: claude ? CLAUDE_SKILL_RESOLUTION_ACTION : OPENCODE_SKILL_RESOLUTION_ACTION,
    SKILL_DELEGATION_STEP: claude ? CLAUDE_SKILL_DELEGATION_STEP : OPENCODE_SKILL_DELEGATION_STEP,
    SKILL_TOOL_BULLET: claude ? CLAUDE_SKILL_TOOL_BULLET : OPENCODE_SKILL_TOOL_BULLET,
    COMPLETION_MESSAGE_GUIDANCE: claude ? CLAUDE_COMPLETION_MESSAGE_GUIDANCE : OPENCODE_COMPLETION_MESSAGE_GUIDANCE,
  };
}
