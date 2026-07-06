import { describe, it, expect } from 'vitest';
import { GitLabHost } from '../client.js';

describe('GitLabHost skeleton', () => {
  it('reports kind gitlab and least-capable defaults', () => {
    const host = new GitLabHost();
    expect(host.kind).toBe('gitlab');
    expect(host.capabilities().securityAlerts).toBe(false);
  });

  it('builds a clone URL from GITLAB_BASE_URL', () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    const host = new GitLabHost();
    expect(host.cloneUrl('group/proj')).toBe('https://gl.example/group/proj.git');
  });
});
