import { describe, it, expect } from 'vitest';
import { CLAUDE_RUNTIME_CAPABILITIES, OPENCODE_RUNTIME_CAPABILITIES } from '../capabilities.js';

describe('runtime capability descriptors', () => {
  it('claude runtime advertises all five capabilities', () => {
    expect(CLAUDE_RUNTIME_CAPABILITIES.osSandbox).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.skills).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.oneMillionContext).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.effort).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.backgroundTasks).toBe(true);
  });

  it('opencode runtime advertises skills + 1M-context + OS sandbox (P3b, Linux); no per-turn effort or background-task tracking', () => {
    expect(OPENCODE_RUNTIME_CAPABILITIES.skills).toBe(true);
    // 1M context comes from the configured model (e.g. glm-5.2) — declared true.
    expect(OPENCODE_RUNTIME_CAPABILITIES.oneMillionContext).toBe(true);
    // P3b per-child bwrap jail + egress proxy, live-verified in the container smoke
    // (Linux deploy target; darwin dev runs unwrapped — documented caveat).
    expect(OPENCODE_RUNTIME_CAPABILITIES.osSandbox).toBe(true);
    // No per-turn effort knob in opencode; subtasks exist but aren't wired into
    // the agent busy/idle accounting yet.
    expect(OPENCODE_RUNTIME_CAPABILITIES.effort).toBe(false);
    expect(OPENCODE_RUNTIME_CAPABILITIES.backgroundTasks).toBe(false);
  });
});
