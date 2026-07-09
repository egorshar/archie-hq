import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileSyncMock = vi.fn();
vi.mock('fs', () => ({ readFileSync: (...a: unknown[]) => readFileSyncMock(...a) }));
vi.mock('os', () => ({ homedir: () => '/home/test' }));
const systemMock = vi.fn();
vi.mock('../logger.js', () => ({ logger: { system: (m: string) => systemMock(m) } }));

import {
  resolveClaudeCredential,
  claudeCredentialEnv,
  assertClaudeCredentialAvailable,
} from '../claude-credential.js';

const savedApiKey = process.env.ANTHROPIC_API_KEY;
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(() => {
  readFileSyncMock.mockReset();
  systemMock.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

describe('resolveClaudeCredential', () => {
  it('resolves api_key from ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('api_key');
    expect(r.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('resolves oauth_token_env from CLAUDE_CODE_OAUTH_TOKEN when no api key', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('oauth_token_env');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' });
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('prefers api key over env token', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(resolveClaudeCredential().kind).toBe('api_key');
  });

  it('reads host login access token when no env credentials', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'host-tok' } }),
    );
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('oauth_token_host');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'host-tok' });
  });

  it('falls through to none on missing/unreadable credentials file', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(resolveClaudeCredential().kind).toBe('none');
  });

  it('falls through to none on malformed json or missing field', () => {
    readFileSyncMock.mockReturnValue('{ not json');
    expect(resolveClaudeCredential().kind).toBe('none');
    readFileSyncMock.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));
    expect(resolveClaudeCredential().kind).toBe('none');
  });
});

describe('claudeCredentialEnv', () => {
  it('returns the env fragment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(claudeCredentialEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' });
  });

  it('returns {} when nothing resolves', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(claudeCredentialEnv()).toEqual({});
  });
});

describe('assertClaudeCredentialAvailable', () => {
  it('throws when no credential is available', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => assertClaudeCredentialAvailable()).toThrow(/No Claude credential/);
  });

  it('logs the resolved kind and does not throw when available', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assertClaudeCredentialAvailable();
    expect(systemMock).toHaveBeenCalledWith('Claude auth: api_key');
  });
});
