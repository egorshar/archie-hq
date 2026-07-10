import { describe, it, expect } from 'vitest';
import { GITHUB_CAPABILITIES, CLAUDE_RUNTIME_CAPABILITIES, OPENCODE_RUNTIME_CAPABILITIES } from '../capabilities.js';

describe('capability descriptors', () => {
  it('github advertises reviews, security alerts, re-review; no native auto-merge', () => {
    expect(GITHUB_CAPABILITIES.reviewStates).toBe(true);
    expect(GITHUB_CAPABILITIES.securityAlerts).toBe(true);
    expect(GITHUB_CAPABILITIES.reReviewRequest).toBe(true);
    expect(GITHUB_CAPABILITIES.nativeAutoMerge).toBe(false);
  });

  it('claude runtime advertises all five capabilities', () => {
    expect(CLAUDE_RUNTIME_CAPABILITIES.osSandbox).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.skills).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.oneMillionContext).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.effort).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.backgroundTasks).toBe(true);
  });

  it('opencode runtime advertises skills + 1M-context; no OS sandbox, per-turn effort, or background-task tracking', () => {
    expect(OPENCODE_RUNTIME_CAPABILITIES.skills).toBe(true);
    // 1M context comes from the configured model (e.g. glm-5.2) — declared true.
    expect(OPENCODE_RUNTIME_CAPABILITIES.oneMillionContext).toBe(true);
    expect(OPENCODE_RUNTIME_CAPABILITIES.osSandbox).toBe(false);
    // No per-turn effort knob in opencode; subtasks exist but aren't wired into
    // the agent busy/idle accounting yet.
    expect(OPENCODE_RUNTIME_CAPABILITIES.effort).toBe(false);
    expect(OPENCODE_RUNTIME_CAPABILITIES.backgroundTasks).toBe(false);
  });
});
