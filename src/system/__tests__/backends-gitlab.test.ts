import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveRepoHostKind, assertBackendConfig, getBackendMatrix } from '../backends.js';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

describe('backends resolver — gitlab', () => {
  it('resolves REPO_HOST=gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(resolveRepoHostKind()).toBe('gitlab');
  });

  it('accepts gitlab when all env is present', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).not.toThrow();
  });

  it('rejects gitlab with a missing env var, naming it', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    delete process.env.GITLAB_TOKEN;
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).toThrow(/GITLAB_TOKEN/);
  });

  it('reports the resolved matrix for gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    delete process.env.AGENT_RUNTIME;
    expect(getBackendMatrix()).toEqual({ repoHost: 'gitlab', runtime: 'claude' });
  });
});
