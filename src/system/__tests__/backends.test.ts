import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveAgentRuntimeKind, assertBackendConfig, getBackendMatrix, getAgentRuntime } from '../backends.js';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe('backends config resolver', () => {
  it('defaults the agent runtime to claude when AGENT_RUNTIME is unset', () => {
    delete process.env.AGENT_RUNTIME;
    expect(resolveAgentRuntimeKind()).toBe('claude');
  });

  it('honors AGENT_RUNTIME=claude explicitly', () => {
    process.env.AGENT_RUNTIME = 'claude';
    expect(resolveAgentRuntimeKind()).toBe('claude');
  });

  it('reports the resolved matrix', () => {
    delete process.env.AGENT_RUNTIME;
    expect(getBackendMatrix()).toEqual({ runtime: 'claude' });
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

  it('getAgentRuntime returns the claude runtime by default', () => {
    delete process.env.AGENT_RUNTIME;
    expect(getAgentRuntime().kind).toBe('claude');
  });
});
