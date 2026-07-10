import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOpencodeModel, opencodeFooterModel, resolveAgentOpencodeModel, opencodeAgentRoute } from '../model.js';
import { modelDisplayLabel } from '../../../agents/model-label.js';
import type { AgentDef } from '../../../types/agent.js';

const ENV_KEYS = ['ARCHIE_OPENCODE_MODEL_HAIKU', 'ARCHIE_OPENCODE_MODEL_SONNET', 'ARCHIE_OPENCODE_MODEL_DEFAULT', 'ARCHIE_OPENCODE_MODEL_OPUS'];
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

  it('trims a provider-wrapper prefix off a multi-segment claude route so modelDisplayLabel can beautify it', () => {
    // A real route like `openrouter/anthropic/claude-haiku-4-5` splits (at the
    // FIRST '/') into providerID `openrouter`, modelID `anthropic/claude-haiku-4-5`
    // — the raw `${providerID}/${modelID}` would be
    // `openrouter/anthropic/claude-haiku-4-5`, which beautify() can't parse
    // because it only strips a LEADING `(anthropic/)?claude-`.
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openrouter/anthropic/claude-haiku-4-5';
    const footer = opencodeFooterModel();
    expect(footer).toBe('anthropic/claude-haiku-4-5');
    expect(modelDisplayLabel(footer!)).toBe('Haiku 4.5');
  });

  it('passes through a non-claude multi-segment route unchanged', () => {
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openrouter/openai/gpt-4o';
    expect(opencodeFooterModel()).toBe('openrouter/openai/gpt-4o');
  });
});

function def(overrides: Partial<AgentDef> = {}): AgentDef {
  return { id: 'a', key: 'k', role: 'R', expertise: 'E', pluginName: 'p', visibility: 'global', ...overrides } as AgentDef;
}

describe('resolveAgentOpencodeModel', () => {
  it('routes a PM (no def.model) via the OPUS tier', () => {
    process.env.ARCHIE_OPENCODE_MODEL_OPUS = 'openrouter/z-ai/glm-5.2';
    expect(resolveAgentOpencodeModel(def({ isPm: true }))).toEqual({ providerID: 'openrouter', modelID: 'z-ai/glm-5.2' });
  });

  it('routes a specialist (no def.model) via the SONNET tier, stripping the [1m] suffix', () => {
    process.env.ARCHIE_OPENCODE_MODEL_SONNET = 'openrouter/x/sonnet-route';
    expect(resolveAgentOpencodeModel(def({ isPm: false }))).toEqual({ providerID: 'openrouter', modelID: 'x/sonnet-route' });
  });

  it('routes an explicit def.model alias via its tier', () => {
    process.env.ARCHIE_OPENCODE_MODEL_HAIKU = 'anthropic/claude-haiku-4-5';
    expect(resolveAgentOpencodeModel(def({ model: 'haiku' as any }))).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' });
  });

  it('falls back to the DEFAULT tier when the agent tier is unset', () => {
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openrouter/z-ai/glm-5.2';
    expect(resolveAgentOpencodeModel(def({ isPm: false }))).toEqual({ providerID: 'openrouter', modelID: 'z-ai/glm-5.2' });
  });
});

describe('opencodeAgentRoute', () => {
  it('returns the agent route trimmed so a claude-wrapped id beautifies', () => {
    process.env.ARCHIE_OPENCODE_MODEL_OPUS = 'openrouter/anthropic/claude-haiku-4-5';
    // provider-wrapper prefix trimmed to the claude id, so modelDisplayLabel can beautify it.
    expect(opencodeAgentRoute(def({ isPm: true }))).toBe('anthropic/claude-haiku-4-5');
  });

  it('passes a non-claude route through unchanged', () => {
    process.env.ARCHIE_OPENCODE_MODEL_SONNET = 'openrouter/z-ai/glm-5.2';
    expect(opencodeAgentRoute(def({ isPm: false }))).toBe('openrouter/z-ai/glm-5.2');
  });

  it('returns null when the route cannot be resolved', () => {
    // no tiers and no DEFAULT set (ENV_KEYS cleared in beforeEach) → resolve throws → null
    expect(opencodeAgentRoute(def({ isPm: false }))).toBeNull();
  });
});
