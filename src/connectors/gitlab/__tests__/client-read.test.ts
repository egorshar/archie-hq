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

function mockFetchOnce(json: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(json), { status, headers }));
}

describe('GitLabHost.getPRStatus', () => {
  it('maps MR + approvals into canonical PRStatus', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const fetchMock = vi.fn()
      // MR
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 7, state: 'opened', merged: false, detailed_merge_status: 'mergeable',
      }), { status: 200 }))
      // approvals
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const status = await host.getPRStatus('group/proj', 7);
    expect(status).toEqual({ state: 'open', mergeable: true, mergeableState: 'clean', approved: true });
  });

  it('marks non-clean detailed_merge_status as not mergeable', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 7, state: 'opened', merged: false, detailed_merge_status: 'conflict',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: false }), { status: 200 })));
    const host = new GitLabHost();
    const status = await host.getPRStatus('group/proj', 7);
    expect(status.mergeableState).toBe('dirty');
    expect(status.mergeable).toBe(false);
  });
});

describe('GitLabHost.getPRComments', () => {
  it('maps MR notes into canonical PRComment[]', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce([
      { id: 1, author: { username: 'alice' }, body: 'hi', created_at: '2026-01-01T00:00:00Z', system: false },
      { id: 2, author: { username: 'bot' }, body: 'x', created_at: '2026-01-01T00:01:00Z', system: true },
    ]));
    const host = new GitLabHost();
    const comments = await host.getPRComments('group/proj', 7);
    expect(comments).toHaveLength(1); // system note filtered out
    expect(comments[0]).toMatchObject({ id: 1, author: 'alice', body: 'hi' });
  });
});
