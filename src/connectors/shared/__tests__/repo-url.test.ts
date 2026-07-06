import { describe, it, expect, afterEach } from 'vitest';
import { repoEventPrefix, repoCloneUrl } from '../repo-url.js';

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

describe('repoCloneUrl', () => {
  it('builds a github.com URL by default', () => {
    delete process.env.REPO_HOST;
    expect(repoCloneUrl('org/backend')).toBe('https://github.com/org/backend.git');
  });
  it('builds a GitLab URL from GITLAB_BASE_URL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    expect(repoCloneUrl('grp/proj')).toBe('https://gl.example/grp/proj.git');
  });
  it('strips a trailing slash from GITLAB_BASE_URL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example/';
    expect(repoCloneUrl('grp/proj')).toBe('https://gl.example/grp/proj.git');
  });
});
