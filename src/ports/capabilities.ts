/**
 * Capability descriptors (spec principle P3): where a runtime cannot match a
 * capability, the gap is declared here and degraded gracefully — never silent.
 */

export interface RuntimeCapabilities {
  /** built-in OS-level sandbox (Claude SDK bubblewrap). */
  osSandbox: boolean;
  /** native Skills support. */
  skills: boolean;
  /** 1M-context models available. */
  oneMillionContext: boolean;
  /** per-turn reasoning-effort control. */
  effort: boolean;
  /** background/subagent tasks surfaced as events. */
  backgroundTasks: boolean;
}

export const CLAUDE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  osSandbox: true,
  skills: true,
  oneMillionContext: true,
  effort: true,
  backgroundTasks: true,
};

/**
 * opencode runtime. These flags are declarative (spec P3: document parity,
 * degrade gracefully) — nothing branches on them yet. P3b added a per-child OS
 * sandbox: on Linux (the deploy target) every serve child runs inside a
 * fail-closed bwrap filesystem jail with a cooperative egress proxy (see
 * runtime/opencode/child-sandbox.ts); on darwin dev it runs unwrapped (env
 * pruning + proxy still apply). `osSandbox: true` reflects that production
 * (Linux) posture — verified live in the container smoke: both the read-only
 * and edit-mode clone profiles jail correctly (clone RO with a `.opencode` rw
 * carve-out; clone RW with `.git/HEAD` denied), `/app` and out-of-mount writes
 * are denied in-jail, and the child env carries no orchestrator secrets. The
 * darwin-dev unwrapped path is the documented caveat above, not a retraction of
 * the capability. Native skills ARE
 * supported: the embedded server exposes opencode's `skill` tool over the
 * agent's staged skills (see runtime/opencode/skills.ts).
 */
export const OPENCODE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  osSandbox: true,
  skills: true,
  // Available through the configured model (e.g. glm-5.2 has a 1M window) — a
  // model property, not something Archie toggles. Pick a 1M model for large
  // tasks. See docs/guides/opencode-setup.md.
  oneMillionContext: true,
  // No per-turn reasoning-effort control: the opencode prompt body has no effort
  // field, and the SDK's `reasoning` is only a per-model can-it-reason
  // descriptor — not a per-turn knob (unlike the Claude SDK's `effort`).
  effort: false,
  // opencode HAS subtasks/subagents (SubtaskPart, surfaced via
  // message.part.updated), but the runtime doesn't yet feed them into the agent
  // busy/idle accounting the way the Claude SDK path does — a follow-up if
  // opencode agents start spawning subtasks.
  backgroundTasks: false,
};
