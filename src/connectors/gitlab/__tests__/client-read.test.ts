import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabHost } from '../client.js';

const ENV_SNAPSHOT = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ENV_SNAPSHOT };
});

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

describe('GitLabHost.probeCapabilities', () => {
  it('raises securityAlerts when /license reports Ultimate', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ plan: 'ultimate' }), { status: 200 })
    ));
    const host = new GitLabHost();
    await host.probeCapabilities();
    expect(host.capabilities().securityAlerts).toBe(true);
  });

  it('leaves securityAlerts false when /license is forbidden (Free/CE)', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    const host = new GitLabHost();
    await host.probeCapabilities();
    expect(host.capabilities().securityAlerts).toBe(false);
  });
});
