import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOpencodeModel, opencodeFooterModel } from '../model.js';

const ENV_KEYS = ['ARCHIE_OPENCODE_MODEL_HAIKU', 'ARCHIE_OPENCODE_MODEL_SONNET', 'ARCHIE_OPENCODE_MODEL_DEFAULT'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveOpencodeModel', () => {
  it('passes through a provider/model spec', () => {
    expect(resolveOpencodeModel('anthropic/claude-haiku-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
  });

  it('keeps extra slashes in the model id', () => {
    expect(resolveOpencodeModel('openrouter/anthropic/claude-3.5')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude-3.5',
    });
  });

  it('resolves a logical name via its per-logical env var', () => {
    process.env.ARCHIE_OPENCODE_MODEL_HAIKU = 'anthropic/claude-haiku-4-5';
    expect(resolveOpencodeModel('haiku')).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' });
  });

  it('falls back to ARCHIE_OPENCODE_MODEL_DEFAULT', () => {
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openai/gpt-5';
    expect(resolveOpencodeModel('sonnet')).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  it('prefers the per-logical var over the default', () => {
    process.env.ARCHIE_OPENCODE_MODEL_SONNET = 'anthropic/claude-sonnet-5';
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openai/gpt-5';
    expect(resolveOpencodeModel('sonnet')).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
  });

  it('throws with an actionable message when unresolvable', () => {
    expect(() => resolveOpencodeModel('haiku')).toThrow(/ARCHIE_OPENCODE_MODEL_HAIKU/);
    expect(() => resolveOpencodeModel('haiku')).toThrow(/ARCHIE_OPENCODE_MODEL_DEFAULT/);
  });

  it('ignores a malformed (no-slash) env value and throws', () => {
    process.env.ARCHIE_OPENCODE_MODEL_HAIKU = 'not-a-ref';
    expect(() => resolveOpencodeModel('haiku')).toThrow(/Cannot resolve/);
  });
});

describe('opencodeFooterModel', () => {
  it('returns the resolved default route as provider/model', () => {
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'anthropic/claude-haiku-4-5';
    expect(opencodeFooterModel()).toBe('anthropic/claude-haiku-4-5');
  });
  it('returns null when unresolved', () => {
    delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
    expect(opencodeFooterModel()).toBeNull();
  });
});
