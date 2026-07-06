import { describe, it, expect } from 'vitest';
import { GITHUB_CAPABILITIES, CLAUDE_RUNTIME_CAPABILITIES } from '../capabilities.js';

describe('capability descriptors', () => {
  it('github advertises reviews, security alerts, re-review; no native auto-merge', () => {
    expect(GITHUB_CAPABILITIES.reviewStates).toBe(true);
    expect(GITHUB_CAPABILITIES.securityAlerts).toBe(true);
    expect(GITHUB_CAPABILITIES.reReviewRequest).toBe(true);
    expect(GITHUB_CAPABILITIES.nativeAutoMerge).toBe(false);
  });

  it('claude runtime advertises OS sandbox, skills, 1M context', () => {
    expect(CLAUDE_RUNTIME_CAPABILITIES.osSandbox).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.skills).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.oneMillionContext).toBe(true);
  });
});
