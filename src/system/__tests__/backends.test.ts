import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveRepoHostKind, assertBackendConfig, getBackendMatrix, getAgentRuntime } from '../backends.js';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe('backends config resolver', () => {
  it('defaults repo host to github when REPO_HOST is unset', () => {
    delete process.env.REPO_HOST;
    expect(resolveRepoHostKind()).toBe('github');
  });

  it('honors REPO_HOST=github explicitly', () => {
    process.env.REPO_HOST = 'github';
    expect(resolveRepoHostKind()).toBe('github');
  });

  it('rejects an unknown REPO_HOST value', () => {
    process.env.REPO_HOST = 'bitbucket';
    expect(() => assertBackendConfig()).toThrow(/REPO_HOST/);
  });

  it('rejects gitlab in phase 0 (not yet implemented)', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(() => assertBackendConfig()).toThrow(/not available|gitlab/i);
  });

  it('reports the resolved matrix', () => {
    delete process.env.REPO_HOST;
    delete process.env.AGENT_RUNTIME;
    expect(getBackendMatrix()).toEqual({ repoHost: 'github', runtime: 'claude' });
  });

  it('accepts AGENT_RUNTIME=opencode when a model route is configured', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'anthropic/claude-haiku-4-5';
    expect(() => assertBackendConfig()).not.toThrow();
  });

  it('rejects AGENT_RUNTIME=opencode with no model route, actionably', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
    delete process.env.ARCHIE_OPENCODE_MODEL_OPUS;
    delete process.env.ARCHIE_OPENCODE_MODEL_SONNET;
    expect(() => assertBackendConfig()).toThrow(/ARCHIE_OPENCODE_MODEL/);
  });

  it('rejects an invalid AGENT_RUNTIME value', () => {
    process.env.AGENT_RUNTIME = 'gpt';
    expect(() => assertBackendConfig()).toThrow(/AGENT_RUNTIME/);
  });

  it('getAgentRuntime returns the opencode runtime for AGENT_RUNTIME=opencode', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'anthropic/claude-haiku-4-5';
    expect(getAgentRuntime().kind).toBe('opencode');
  });
});
