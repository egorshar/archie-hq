import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { SessionRegistry } from '../registry.js';
import { startBridgeServer, RO_BUILTIN_BLOCK, type BridgeHandle } from '../server.js';
import { getSharedPath, getTaskPath } from '../../../../tasks/persistence.js';

// find_slack_user (a PM-only comms tool exercised below) calls the real Slack
// API via findSlackUsers unless stubbed — there's no bot token in test env, so
// stub just that lookup and keep every other export of the module real.
vi.mock('../../../../connectors/slack/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../connectors/slack/client.js')>();
  return { ...actual, findSlackUsers: vi.fn().mockResolvedValue([]) };
});

function fakeSession() {
  const posted: any[] = [];
  const task: any = { taskId: 't1' };
  const agent: any = { def: { id: 'pm-agent' }, __posted: posted };
  return { task, agent, posted };
}

describe('bridge server', () => {
  let handle: BridgeHandle;
  let registry: SessionRegistry;
  beforeEach(async () => { registry = new SessionRegistry(); handle = await startBridgeServer(registry); });
  afterEach(async () => { await handle.close(); });

  it('rejects a request without the bearer token', async () => {
    const res = await fetch(`${handle.url}/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's', tool: 'post_to_user', args: {} }) });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown session', async () => {
    const res = await fetch(`${handle.url}/tool`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` }, body: JSON.stringify({ sessionId: 'nope', tool: 'post_to_user', args: {} }) });
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/session/i);
  });

  it('rejects a non-whitelisted tool name', async () => {
    const { task, agent } = fakeSession();
    registry.set('s1', { task, agent, readOnly: false });
    const res = await fetch(`${handle.url}/tool`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` }, body: JSON.stringify({ sessionId: 's1', tool: 'rm_rf', args: {} }) });
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/unknown tool|not permitted/i);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects prototype-chain tool name %s exactly like an unknown tool',
    async (toolName) => {
      const { task, agent } = fakeSession();
      registry.set('s1', { task, agent, readOnly: false });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 's1', tool: toolName, args: {} }),
      });
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/unknown tool|not permitted/i);
    },
  );

  it('rejects a null JSON body with a clean 400 instead of throwing', async () => {
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: 'null',
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  it('rejects a non-object JSON body (array) with a clean error, not ok:true', async () => {
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: '[1,2,3]',
    });
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  it('rejects an oversized body instead of buffering it unbounded', async () => {
    const hugeArg = 'x'.repeat(2 * 1024 * 1024); // 2 MB, over the 1 MB cap
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ sessionId: 's1', tool: 'post_to_user', args: { message: hugeArg } }),
    });
    expect(res.status).toBe(413);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
  });

  it('binds to loopback only', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('returns the tool result as an unwrapped string, not a ToolResult object', async () => {
    // A task with isActive:false makes reportCompletionHandler short-circuit
    // on its very first branch, returning a plain
    // `{ content: [{ type: 'text', text }] }` ToolResult without touching
    // anything else on the stub — a minimal, real exercise of the unwrap.
    const task: any = { taskId: 't1', isActive: false };
    const agent: any = { def: { id: 'pm-agent' } };
    registry.set('s1', { task, agent, readOnly: false });
    const res = await fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ sessionId: 's1', tool: 'report_completion', args: {} }),
    });
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.result).toBe('string');
    expect(body.result).toBe('Task already completed. End your turn.');
  });

  describe('GET /tools', () => {
    it('rejects a request without the bearer token', async () => {
      const res = await fetch(`${handle.url}/tools`);
      expect(res.status).toBe(401);
    });

    it('returns the manifest with a valid bearer token', async () => {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.some((t: any) => t.name === 'post_to_user')).toBe(true);
    });
  });

  describe('GET /policy', () => {
    it('rejects a request without the bearer token', async () => {
      const res = await fetch(`${handle.url}/policy?sessionId=s1`);
      expect(res.status).toBe(401);
    });

    it('returns readOnly:true with the RO_BUILTIN_BLOCK set for a read-only session (PM: editModeApplies false)', async () => {
      const { task, agent } = fakeSession(); // pm-agent → not a repo agent
      registry.set('s1', { task, agent, readOnly: true });
      const res = await fetch(`${handle.url}/policy?sessionId=s1`, { headers: { authorization: `Bearer ${handle.token}` } });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ readOnly: true, blockedTools: RO_BUILTIN_BLOCK, editModeApplies: false });
    });

    it('returns readOnly:false with an empty blockedTools set for an edit-mode session', async () => {
      const { task, agent } = fakeSession();
      registry.set('s1', { task, agent, readOnly: false });
      const res = await fetch(`${handle.url}/policy?sessionId=s1`, { headers: { authorization: `Bearer ${handle.token}` } });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body).toEqual({ readOnly: false, blockedTools: [], editModeApplies: false });
    });

    it('editModeApplies:true for a read-only REPO agent (edit mode would make it writable)', async () => {
      const { task, agent } = fakeSession();
      agent.def.repo = { repos: [{ github: 'org/r', baseBranch: 'main' }], primary: 'org/r' };
      registry.set('s1', { task, agent, readOnly: true });
      const res = await fetch(`${handle.url}/policy?sessionId=s1`, { headers: { authorization: `Bearer ${handle.token}` } });
      const body: any = await res.json();
      expect(body).toEqual({ readOnly: true, blockedTools: RO_BUILTIN_BLOCK, editModeApplies: true });
    });

    it('returns not-ok for an unknown session instead of throwing', async () => {
      const res = await fetch(`${handle.url}/policy?sessionId=nope`, { headers: { authorization: `Bearer ${handle.token}` } });
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
    });

    it('returns not-ok when sessionId is missing from the query string', async () => {
      const res = await fetch(`${handle.url}/policy`, { headers: { authorization: `Bearer ${handle.token}` } });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  describe('repo-tools whitelist + RO write rejection', () => {
    // A minimal repo-agent session: `def.repo` + `metadata.repositories` are
    // enough for the repo-tool handlers' `resolveGithub`/`requireAttached`
    // helpers to run for real (no external mocking) — the attached repo has
    // no `clone_path`, so a write tool that reaches its handler fails
    // gracefully with a "no local clone" ToolResult instead of throwing. That
    // graceful failure (`ok:true`, error text as the result) is exactly what
    // distinguishes "dispatched" from "rejected pre-dispatch" (`ok:false`,
    // read-only error) in the tests below.
    function fakeRepoAgentSession() {
      const task: any = {
        taskId: 't1',
        metadata: { repositories: { 'repo-agent': [{ github: 'org/repo' }] } },
      };
      const agent: any = {
        def: { id: 'repo-agent', repo: { primary: 'org/repo', repos: [{ github: 'org/repo' }] } },
      };
      return { task, agent };
    }

    it('rejects a write repo-tool (push_branch) for a read-only session before dispatch', async () => {
      const { task, agent } = fakeRepoAgentSession();
      registry.set('ro-write', { task, agent, readOnly: true });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 'ro-write', tool: 'push_branch', args: {} }),
      });
      const body: any = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/read-only/i);
      expect(body.error).toMatch(/push_branch/);
    });

    it('dispatches a write repo-tool (push_branch) for an edit-mode (non-RO) session', async () => {
      const { task, agent } = fakeRepoAgentSession();
      registry.set('edit-write', { task, agent, readOnly: false });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 'edit-write', tool: 'push_branch', args: {} }),
      });
      const body: any = await res.json();
      // Reached the real handler (not pre-dispatch rejected): it fails
      // gracefully because the fake attached repo has no clone_path.
      expect(body.ok).toBe(true);
      expect(body.result).toMatch(/no local clone/i);
    });

    it('allows a read repo-tool (list_branches) for a read-only session', async () => {
      const { task, agent } = fakeRepoAgentSession();
      registry.set('ro-read', { task, agent, readOnly: true });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 'ro-read', tool: 'list_branches', args: {} }),
      });
      const body: any = await res.json();
      expect(body.ok).toBe(true);
    });

    it('allows a read repo-tool (list_branches) for an edit-mode session', async () => {
      const { task, agent } = fakeRepoAgentSession();
      registry.set('edit-read', { task, agent, readOnly: false });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 'edit-read', tool: 'list_branches', args: {} }),
      });
      const body: any = await res.json();
      expect(body.ok).toBe(true);
    });

    it('includes repo-tool names in the /tools manifest', async () => {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      const body: any = await res.json();
      expect(body.some((t: any) => t.name === 'push_branch')).toBe(true);
      expect(body.some((t: any) => t.name === 'list_branches')).toBe(true);
      expect(body.some((t: any) => t.name === 'get_pr_status')).toBe(true);
    });
  });

  describe('comms/orchestration/scheduling — PM-only scoping', () => {
    // A minimal non-PM (repo agent) session: `def.isPm` unset/false.
    function fakeNonPmSession() {
      const task: any = { taskId: 't1', metadata: { repositories: {} } };
      const agent: any = { def: { id: 'repo-agent', repo: { primary: 'org/repo', repos: [{ github: 'org/repo' }] } } };
      return { task, agent };
    }

    // A minimal PM session: `def.isPm: true`.
    function fakePmSession() {
      const task: any = {
        taskId: 't1',
        metadata: { channels: {}, reminder: undefined },
        getAgentStatus: () => [],
      };
      const agent: any = { def: { id: 'pm-agent', isPm: true } };
      return { task, agent };
    }

    it.each(['launch_task', 'set_reminder', 'find_slack_user'])(
      'rejects %s for a non-PM session (unknown tool, not permitted)',
      async (toolName) => {
        const { task, agent } = fakeNonPmSession();
        registry.set('non-pm', { task, agent, readOnly: false });
        const res = await fetch(`${handle.url}/tool`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
          body: JSON.stringify({ sessionId: 'non-pm', tool: toolName, args: {} }),
        });
        const body: any = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/unknown tool|not permitted/i);
      },
    );

    it.each(['launch_task', 'set_reminder', 'find_slack_user'])(
      'dispatches %s for a PM session (reaches the real handler)',
      async (toolName) => {
        const { task, agent } = fakePmSession();
        registry.set('pm', { task, agent, readOnly: false });
        const res = await fetch(`${handle.url}/tool`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
          body: JSON.stringify({ sessionId: 'pm', tool: toolName, args: toolName === 'set_reminder' ? { datetime: '2099-01-01T00:00:00Z', reason: 'x' } : { query: 'x' } }),
        });
        const body: any = await res.json();
        // Reached the real handler (not pre-dispatch rejected as unknown).
        expect(body.ok).toBe(true);
      },
    );

    it('includes PM-only tool names in the /tools manifest even though it is not session-scoped', async () => {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      const body: any = await res.json();
      expect(body.some((t: any) => t.name === 'launch_task')).toBe(true);
      expect(body.some((t: any) => t.name === 'set_reminder')).toBe(true);
      expect(body.some((t: any) => t.name === 'find_slack_user')).toBe(true);
    });
  });

  describe('web_research', () => {
    // runWebResearch checks PERPLEXITY_API_KEY before the budget check; stub
    // a dummy value so the budget-exceeded case (below) short-circuits before
    // any network call. appendAgentFinding on that path writes a real
    // knowledge.log under <task>/shared/, so create the directory a real
    // Task.create() would have.
    const TASK_ID = 'test-bridge-web-research';
    const ORIGINAL_PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

    beforeEach(async () => {
      process.env.PERPLEXITY_API_KEY = 'test-key';
      await mkdir(getSharedPath(TASK_ID), { recursive: true });
    });

    afterEach(async () => {
      if (ORIGINAL_PERPLEXITY_API_KEY === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = ORIGINAL_PERPLEXITY_API_KEY;
      }
      await rm(getTaskPath(TASK_ID), { recursive: true, force: true });
    });

    function fakeResearchSession(budgetAllowed: boolean) {
      const task: any = {
        taskId: TASK_ID,
        checkResearchBudget: () => ({ allowed: budgetAllowed, used: budgetAllowed ? 0 : 5, limit: 5 }),
        incrementResearchCount: vi.fn(),
        onResearchBudgetExceeded: vi.fn(async () => {}),
      };
      const agent: any = { def: { id: 'pm-agent' } };
      return { task, agent };
    }

    it('includes web_research in the /tools manifest', async () => {
      const res = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${handle.token}` } });
      const body: any = await res.json();
      expect(body.some((t: any) => t.name === 'web_research')).toBe(true);
    });

    it('is not blocked by the read-only write-tool rejection (research is not a repo write)', async () => {
      const { task, agent } = fakeResearchSession(false);
      registry.set('ro-research', { task, agent, readOnly: true });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 'ro-research', tool: 'web_research', args: { topic: 'x' } }),
      });
      const body: any = await res.json();
      // Reached the real handler (not pre-dispatch rejected as a write tool).
      expect(body.ok).toBe(true);
    });

    it('dispatches to the real handler end-to-end: budget-exceeded triggers the stop flow and returns a defense-wrapped result', async () => {
      const { task, agent } = fakeResearchSession(false);
      registry.set('s-research', { task, agent, readOnly: false });
      const res = await fetch(`${handle.url}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ sessionId: 's-research', tool: 'web_research', args: { topic: 'x' } }),
      });
      const body: any = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.result).toBe('string');
      expect(body.result).toMatch(/^<research_result source="external_web">/);
      expect(body.result).toMatch(/budget exceeded/i);
      expect(task.onResearchBudgetExceeded).toHaveBeenCalled();
    });
  });
});

describe('per-child tokens (A4)', () => {
  let handle: BridgeHandle;
  let registry: SessionRegistry;
  beforeEach(async () => { registry = new SessionRegistry(); handle = await startBridgeServer(registry); });
  afterEach(async () => { await handle.close(); });

  // report_completion on an isActive:false task short-circuits to a plain
  // ToolResult without touching other stubs — a minimal real dispatch (same
  // trick as the unwrap test above).
  const session = (agentId: string) => ({ task: { taskId: 't1', isActive: false } as any, agent: { def: { id: agentId } } as any, readOnly: false });
  const call = (token: string, sessionId: string) =>
    fetch(`${handle.url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId, tool: 'report_completion', args: {} }),
    });

  it('a child token dispatches a tool call for its own agent session', async () => {
    registry.set('s-backend', session('backend'));
    const token = handle.mintChildToken({ taskId: 't1', agentId: 'backend' });
    const body: any = await (await call(token, 's-backend')).json();
    expect(body.ok).toBe(true);
  });

  it("rejects child X's token used against child Y's session (verified caller identity)", async () => {
    registry.set('s-backend', session('backend'));
    const tokenMobile = handle.mintChildToken({ taskId: 't1', agentId: 'mobile' });
    const body: any = await (await call(tokenMobile, 's-backend')).json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/token/i);
  });

  it("rejects a token whose taskId doesn't match the session's task", async () => {
    registry.set('s-backend', session('backend'));
    const tokenOtherTask = handle.mintChildToken({ taskId: 't2', agentId: 'backend' });
    const body: any = await (await call(tokenOtherTask, 's-backend')).json();
    expect(body.ok).toBe(false);
  });

  it('rejects a revoked token with 401 (unknown token)', async () => {
    registry.set('s-backend', session('backend'));
    const token = handle.mintChildToken({ taskId: 't1', agentId: 'backend' });
    handle.revokeChildToken(token);
    expect((await call(token, 's-backend')).status).toBe(401);
  });

  it('child tokens authorize GET /tools and GET /policy', async () => {
    registry.set('s-backend', session('backend'));
    const token = handle.mintChildToken({ taskId: 't1', agentId: 'backend' });
    const tools = await fetch(`${handle.url}/tools`, { headers: { authorization: `Bearer ${token}` } });
    expect(tools.status).toBe(200);
    const policy = await fetch(`${handle.url}/policy?sessionId=s-backend`, { headers: { authorization: `Bearer ${token}` } });
    expect(policy.status).toBe(200);
  });

  it('the process token still dispatches without an identity restriction', async () => {
    registry.set('s-backend', session('backend'));
    const body: any = await (await call(handle.token, 's-backend')).json();
    expect(body.ok).toBe(true);
  });
});
