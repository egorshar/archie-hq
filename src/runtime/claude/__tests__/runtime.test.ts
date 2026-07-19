import { describe, it, expect } from 'vitest';
import { claudeSdkRuntime } from '../runtime.js';
import type { AgentDef } from '../../../types/agent.js';

const def = (over: Partial<AgentDef>): AgentDef => ({ id: 'x', ...over }) as AgentDef;

describe('ClaudeSdkRuntime footer model tokens', () => {
  it('footerModelToken mirrors resolveAgentModel (PM → opus, others → sonnet[1m], declared model wins)', () => {
    expect(claudeSdkRuntime.footerModelToken(def({ id: 'pm-agent', isPm: true }), false)).toBe('opus');
    expect(claudeSdkRuntime.footerModelToken(def({ id: 'backend-agent' }), false)).toBe('sonnet[1m]');
    expect(claudeSdkRuntime.footerModelToken(def({ id: 'assistant-agent', model: 'haiku' }), false)).toBe('haiku');
  });

  it('footerModelDefaultToken is opus (the PM spawn default)', () => {
    expect(claudeSdkRuntime.footerModelDefaultToken()).toBe('opus');
  });
});
