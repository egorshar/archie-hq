/**
 * Disable-merge gates (SOC2 lockdown): when ARCHIE_DISABLE_MERGE is set,
 * `merge_pull_request` is dropped from the active repo-tool set and
 * `isAutoMergeRepo` is forced to false regardless of the repo's declared
 * autoMerge flag.
 *
 * Note on test setup: `isAutoMergeRepo` calls `findAgentDefsContainingRepo`
 * directly within the same module (registry.ts), so mocking that export via
 * `vi.mock('../registry.js', ...)` does not reach the internal call — same-file
 * function references are plain closures, not routed through the module's
 * export bindings. Seeding the registry with `__setRegistryForTesting` (the
 * existing test hook, also used by registry-auto-merge.test.ts) exercises the
 * real code path instead.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { REPO_TOOL_SPECS, activeRepoToolNames } from '../tools.js';
import { isAutoMergeRepo, __setRegistryForTesting } from '../registry.js';
import type { AgentDef } from '../../types/agent.js';

function repoAgentDef(github: string): AgentDef {
  return {
    id: 'backend-agent',
    key: 'backend',
    role: 'r',
    expertise: 'e',
    pluginName: 'engineering',
    visibility: 'global',
    repo: {
      repos: [{ github, baseBranch: 'main', autoMerge: true, postCheckout: false }],
      primary: github,
    },
  } as AgentDef;
}

const KEY = 'ARCHIE_DISABLE_MERGE';
afterEach(() => { delete process.env[KEY]; });

beforeEach(() => {
  __setRegistryForTesting([repoAgentDef('org/x')]);
});

describe('disable-merge gates', () => {
  it('merge_pull_request is a known repo tool', () => {
    expect(REPO_TOOL_SPECS.some((s) => s.name === 'merge_pull_request')).toBe(true);
  });
  it('active repo tools exclude merge_pull_request only when disabled', () => {
    delete process.env[KEY];
    expect(activeRepoToolNames()).toContain('merge_pull_request');
    process.env[KEY] = 'true';
    expect(activeRepoToolNames()).not.toContain('merge_pull_request');
  });
  it('isAutoMergeRepo is false when merge is disabled', () => {
    delete process.env[KEY];
    expect(isAutoMergeRepo('org/x')).toBe(true);
    process.env[KEY] = 'true';
    expect(isAutoMergeRepo('org/x')).toBe(false);
  });
});
