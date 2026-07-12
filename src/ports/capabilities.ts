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
};

export const CLAUDE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  osSandbox: true,
  skills: true,
  oneMillionContext: true,
  effort: true,
  backgroundTasks: true,
};
