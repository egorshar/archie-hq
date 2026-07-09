import { describe, it, expect } from 'vitest';
import { extractOAuthToken, upsertEnvToken } from '../preflight.js';

describe('extractOAuthToken', () => {
  it('extracts a sk-ant-oat token from mixed output', () => {
    const out = [
      'Open this URL to authorize:',
      'https://claude.ai/oauth?x=1',
      '',
      'Your token: sk-ant-oat01-AbC_dEf-123',
      '',
    ].join('\n');
    expect(extractOAuthToken(out)).toBe('sk-ant-oat01-AbC_dEf-123');
  });

  it('falls back to the last non-empty line when no token pattern matches', () => {
    expect(extractOAuthToken('preamble\n\nsome-other-token-value\n\n')).toBe('some-other-token-value');
  });

  it('returns undefined for empty output', () => {
    expect(extractOAuthToken('   \n  \n')).toBeUndefined();
  });
});

describe('upsertEnvToken', () => {
  it('replaces a commented CLAUDE_CODE_OAUTH_TOKEN line in place', () => {
    const env = 'ANTHROPIC_API_KEY=sk-ant-x\n# CLAUDE_CODE_OAUTH_TOKEN=\nPORT=3000\n';
    expect(upsertEnvToken(env, 'sk-ant-oat01-tok')).toBe(
      'ANTHROPIC_API_KEY=sk-ant-x\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-tok\nPORT=3000\n',
    );
  });

  it('replaces an existing populated line', () => {
    const env = 'CLAUDE_CODE_OAUTH_TOKEN=old\nPORT=3000\n';
    expect(upsertEnvToken(env, 'new')).toBe('CLAUDE_CODE_OAUTH_TOKEN=new\nPORT=3000\n');
  });

  it('appends when absent, adding a separating newline', () => {
    expect(upsertEnvToken('PORT=3000', 'tok')).toBe('PORT=3000\nCLAUDE_CODE_OAUTH_TOKEN=tok\n');
  });

  it('appends to empty content without a leading newline', () => {
    expect(upsertEnvToken('', 'tok')).toBe('CLAUDE_CODE_OAUTH_TOKEN=tok\n');
  });

  it('leaves other lines untouched', () => {
    const env = 'A=1\nB=2\nCLAUDE_CODE_OAUTH_TOKEN=old\nC=3\n';
    expect(upsertEnvToken(env, 'tok')).toBe('A=1\nB=2\nCLAUDE_CODE_OAUTH_TOKEN=tok\nC=3\n');
  });
});
