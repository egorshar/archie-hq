import { describe, it, expect, afterEach } from 'vitest';
import { repoEventPrefix } from '../repo-url.js';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('repoEventPrefix', () => {
  it('defaults to github when REPO_HOST is unset', () => {
    delete process.env.REPO_HOST;
    expect(repoEventPrefix()).toBe('github');
  });
  it('returns github for REPO_HOST=github', () => {
    process.env.REPO_HOST = 'github';
    expect(repoEventPrefix()).toBe('github');
  });
  it('returns gitlab for REPO_HOST=gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(repoEventPrefix()).toBe('gitlab');
  });
  it('normalizes case/whitespace', () => {
    process.env.REPO_HOST = '  GitLab ';
    expect(repoEventPrefix()).toBe('gitlab');
  });
});
