/**
 * Capability descriptors (spec principle P3): where a backend cannot match a
 * capability, the gap is declared here and degraded gracefully — never silent.
 */

export interface RepoHostCapabilities {
  /** true: distinct approved / changes_requested review states (GitHub). false: approvals+notes only (GitLab). */
  reviewStates: boolean;
  /** code-scanning / security alerts available (GitHub, GitLab Ultimate). */
  securityAlerts: boolean;
  /** host-native "merge when pipeline succeeds" (GitLab). Archie orchestrates merges itself when false. */
  nativeAutoMerge: boolean;
  /** can request re-review from prior reviewers. */
  reReviewRequest: boolean;
  /** can dispatch a CI workflow run / trigger a pipeline (GitHub workflow_dispatch; GitLab pipeline trigger). */
  workflowDispatch: boolean;
  /** can play a manual/gated CI job by name in a change request's pipeline (GitLab manual jobs). */
  manualJobs: boolean;
}

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

export const GITHUB_CAPABILITIES: RepoHostCapabilities = {
  reviewStates: true,
  securityAlerts: true,
  nativeAutoMerge: false,
  reReviewRequest: true,
  workflowDispatch: false,
  manualJobs: false,
};

/**
 * GitLab defaults — least-capable baseline. reviewStates is false (GitLab has
 * approvals + notes, not distinct approved/changes_requested states — synthesized
 * in Plan 2). securityAlerts starts false and is raised only when the boot-time
 * /license probe reports an Ultimate tier (spec R2). nativeAutoMerge exists
 * ("merge when pipeline succeeds") but Archie keeps orchestrating by default.
 */
export const GITLAB_CAPABILITIES_DEFAULT: RepoHostCapabilities = {
  reviewStates: false,
  securityAlerts: false,
  nativeAutoMerge: true,
  reReviewRequest: false,
  workflowDispatch: true,
  manualJobs: true,
};

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
 * are denied in-jail, and the child env carries no orchestrator secrets (P3b
 * spike runbook + record). The darwin-dev unwrapped path is the documented
 * caveat above, not a retraction of the capability. Native skills ARE
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
