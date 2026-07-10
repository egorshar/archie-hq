import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above these imports; a plain top-level
// `vi.fn()` referenced inside one throws "Cannot access before initialization"
// under this vitest version, so the mock fns are created inside vi.hoisted
// (same pattern as llm-one-shot.test.ts).
const { getOpencodeClient, registrySet, registryDelete } = vi.hoisted(() => ({
  getOpencodeClient: vi.fn(),
  registrySet: vi.fn(),
  registryDelete: vi.fn(),
}));
vi.mock('../server.js', () => ({
  getOpencodeClient,
  concatPromptText: (res: any) => {
    const parts = res?.data?.parts ?? [];
    const t = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
    return t || null;
  },
  sharedRegistry: { set: registrySet, delete: registryDelete },
}));
vi.mock('../model.js', () => ({
  resolveOpencodeModel: (m: string) => ({ providerID: 'anthropic', modelID: m }),
}));
const { prepareAgentContext } = vi.hoisted(() => ({ prepareAgentContext: vi.fn() }));
vi.mock('../../../agents/spawn.js', () => ({ prepareAgentContext }));

import { MessageQueue } from '../../../agents/message-queue.js';
import { OpencodeRuntime, isSessionNotFound, runPromptTurn } from '../runtime.js';
import { turnCompletion } from '../turn-completion.js';

/** Let runPromptTurn reach its `await turn` (after the mocked promptAsync microtasks). */
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeAgent() {
  return {
    def: { id: 'pm', model: 'opus' },
    queue: new MessageQueue(),
    session: { active: false } as any,
    sandbox: undefined as any,
    handle: undefined as any,
    pendingTeardown: undefined as any,
    clearPendingTeardown: vi.fn(),
    backgroundTasks: new Set(),
  };
}
function makeTask() {
  return { taskId: 't1', updateAgentState: vi.fn() };
}

describe('OpencodeRuntime.spawn', () => {
  let promptAsync: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let abort: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    create = vi.fn(async () => ({ data: { id: 'sess-1' } }));
    // promptAsync returns 204 immediately; the real server then emits
    // session.idle when the async turn finishes. Simulate that by completing
    // the turn on a microtask, so turns resolve like the old prompt()-return.
    promptAsync = vi.fn(async (req: any) => {
      queueMicrotask(() => turnCompletion.completeTurn(req.path.id));
      return { data: {} };
    });
    abort = vi.fn(async () => ({ data: {} }));
    getOpencodeClient.mockResolvedValue({ session: { create, promptAsync, abort } });
    registrySet.mockReset();
    registryDelete.mockReset();
    prepareAgentContext.mockReset();
    prepareAgentContext.mockImplementation(async (agent: any) => {
      agent.sandbox = { cwd: '/w' };
      return { systemPrompt: 'SYS', cwd: '/w', additionalDirectories: [], sandboxOpts: { cwd: '/w' } };
    });
  });

  it('fires promptAsync with NO body.model + the system prompt, completes on idle, sets a live handle', async () => {
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);

    expect(agent.handle).toBeTruthy();
    expect(agent.handle.isRunning).toBe(true);
    expect(agent.sandbox).toEqual({ cwd: '/w' });

    agent.queue.addMessage('investigate the login bug', 'alice');
    await tick();

    expect(create).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const body = promptAsync.mock.calls[0][0].body;
    // Model routing is server-global (config.model, set in server.ts) — opencode
    // ignores body.model, so it must not be sent (spike.md §5).
    expect(body).not.toHaveProperty('model');
    expect(body.system).toBe('SYS');
    expect(body.parts[0].text).toContain('investigate the login bug');
    // first response marks active with the session id, then idle marks inactive
    expect(task.updateAgentState).toHaveBeenCalledWith('pm', true, 'sess-1');
    expect(task.updateAgentState).toHaveBeenCalledWith('pm', false);
  });

  it('registers the created session in the bridge registry as {task, agent}', async () => {
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await new Promise((r) => setTimeout(r, 0));

    // Default mock has no `repo` (non-repo/PM agent) → readOnly:true (parity
    // with Claude, which denies PM/plugin agents Bash/Edit/Write entirely).
    expect(registrySet).toHaveBeenCalledWith('sess-1', { task, agent, readOnly: true });
  });

  it('registers a resumed session (no session.create call) under its existing id', async () => {
    const agent = makeAgent();
    agent.session = { active: true, session_id: 'sess-existing' } as any;
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('continue');
    await new Promise((r) => setTimeout(r, 0));

    expect(create).not.toHaveBeenCalled();
    expect(registrySet).toHaveBeenCalledWith('sess-existing', { task, agent, readOnly: true });
  });

  it('de-registers the session from the bridge registry when the queue stops', async () => {
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await new Promise((r) => setTimeout(r, 0));
    expect(registrySet).toHaveBeenCalledWith('sess-1', { task, agent, readOnly: true });

    agent.queue.stop();
    await agent.handle.running;

    expect(registryDelete).toHaveBeenCalledWith('sess-1');
  });

  it('resolves running and flips isRunning false when the queue stops', async () => {
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.stop();
    await agent.handle.running;
    expect(agent.handle.isRunning).toBe(false);
  });

  it('runs a pending teardown exactly once after a turn', async () => {
    const agent = makeAgent();
    const task = makeTask();
    const teardown = vi.fn(async () => {});
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.pendingTeardown = teardown;
    (agent.clearPendingTeardown as any).mockImplementation(() => { agent.pendingTeardown = undefined; });
    agent.queue.addMessage('do it');
    await new Promise((r) => setTimeout(r, 0));
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('degrades gracefully when the embedded server fails to start', async () => {
    const agent = makeAgent();
    const task = makeTask();
    // Embedded-server startup failure (e.g. `spawn opencode ENOENT`) must fail
    // only this agent — spawn() must not reject, handle.running must resolve (not
    // reject), and the agent must end inactive — so recovery re-spawn can't
    // surface an unhandled rejection that crashes the process.
    getOpencodeClient.mockRejectedValueOnce(new Error('spawn opencode ENOENT'));

    await expect(new OpencodeRuntime().spawn(agent as any, task as any)).resolves.toBeUndefined();
    expect(agent.handle).toBeTruthy();
    await expect(agent.handle.running).resolves.toBeUndefined();
    expect(agent.handle.isRunning).toBe(false);
    // Never registered (no session was ever created), so nothing to evict either.
    expect(registrySet).not.toHaveBeenCalled();
    expect(registryDelete).not.toHaveBeenCalled();
  });

  it('registers a repo agent with edit mode OFF as readOnly:true', async () => {
    prepareAgentContext.mockImplementation(async (agent: any) => {
      agent.sandbox = { cwd: '/w' };
      return {
        systemPrompt: 'SYS', cwd: '/w', additionalDirectories: [], sandboxOpts: { cwd: '/w' },
        repo: { editAllowed: false, repoMounts: [], allClonePaths: [] },
      };
    });
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await new Promise((r) => setTimeout(r, 0));

    expect(registrySet).toHaveBeenCalledWith('sess-1', { task, agent, readOnly: true });
  });

  it('registers a repo agent with edit mode ON as readOnly:false', async () => {
    prepareAgentContext.mockImplementation(async (agent: any) => {
      agent.sandbox = { cwd: '/w' };
      return {
        systemPrompt: 'SYS', cwd: '/w', additionalDirectories: [], sandboxOpts: { cwd: '/w' },
        repo: { editAllowed: true, repoMounts: [], allClonePaths: [] },
      };
    });
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await new Promise((r) => setTimeout(r, 0));

    expect(registrySet).toHaveBeenCalledWith('sess-1', { task, agent, readOnly: false });
  });

  it('registers a non-repo (PM) agent as readOnly:true (parity with Claude: no built-in Bash/Edit/Write)', async () => {
    // Default mock (no `repo` field) represents the PM/plugin-agent path — no
    // repo/edit-mode surface. The Claude runtime denies PM/plugin agents
    // Bash/Edit/Write entirely, so opencode must block its built-in
    // edit/write/bash the same way; PM/plugin agents' legitimate tools
    // (bridged custom tools + built-in reads) are unaffected by readOnly.
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await new Promise((r) => setTimeout(r, 0));

    expect(registrySet).toHaveBeenCalledWith('sess-1', { task, agent, readOnly: true });
  });

  it('abort() unblocks the in-flight turn and tells opencode to abort the session', async () => {
    const agent = makeAgent();
    const task = makeTask();
    // A promptAsync that does NOT auto-complete: the turn stays in-flight
    // (awaiting session.idle) so abort() has something to cancel.
    promptAsync.mockImplementation(async () => ({ data: {} }));
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await tick();

    // Turn is parked on `await turn`. Abort cancels the waiter + aborts the
    // opencode-side turn; there is no held-open request / AbortSignal anymore.
    agent.handle.abort();
    expect(abort).toHaveBeenCalledWith({ path: { id: 'sess-1' } });

    agent.queue.stop();
    await agent.handle.running; // resolves — the cancelled turn unblocked the loop
    expect(agent.handle.isRunning).toBe(false);
  });
});

describe('isSessionNotFound', () => {
  it('true on an HTTP 404 error result', () => {
    expect(isSessionNotFound({ error: { status: 404 } })).toBe(true);
  });
  it('true when the prompt info error names a missing session', () => {
    expect(isSessionNotFound({ data: { info: { error: { name: 'SessionNotFoundError' } } } })).toBe(true);
  });
  it('false on a normal successful result', () => {
    expect(isSessionNotFound({ data: { info: {}, parts: [{ type: 'text', text: 'ok' }] } })).toBe(false);
  });
  it('false on an unrelated error', () => {
    expect(isSessionNotFound({ data: { info: { error: { name: 'ProviderAuthError' } } } })).toBe(false);
  });
  it('true for the LIVE opencode not-found shape (captured in the P2-C smoke)', () => {
    // Exact payload observed live: res.error = { name, data: { message } }.
    expect(
      isSessionNotFound({
        error: { name: 'NotFoundError', data: { message: 'Session not found: ses_0b551f041ffeSJnK79rv9NGkOV' } },
      }),
    ).toBe(true);
  });
  it('false for an unrelated NotFoundError-less error object', () => {
    expect(isSessionNotFound({ error: { name: 'ProviderAuthError', data: { message: 'bad key' } } })).toBe(false);
  });
  it('true for a thrown-shaped not-found error object (status)', () => {
    const err = Object.assign(new Error('boom'), { status: 404 });
    expect(isSessionNotFound(err)).toBe(true);
  });
  it('true for a thrown-shaped not-found error object (name/message)', () => {
    expect(isSessionNotFound(new Error('session not found'))).toBe(true);
    expect(isSessionNotFound(Object.assign(new Error('boom'), { name: 'SessionNotFoundError' }))).toBe(true);
  });
  it('false for an unrelated thrown error', () => {
    expect(isSessionNotFound(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('runPromptTurn (promptAsync + session.idle completion)', () => {
  const body = { parts: [{ type: 'text' as const, text: 'hi' }], system: 's' };

  it('awaits session.idle completion and returns the streamed reply text', async () => {
    const promptAsync = vi.fn().mockResolvedValue({ data: {} }); // 204 accept
    const client = { session: { promptAsync, create: vi.fn() } } as any;
    const agent = { def: { id: 'pm' }, session: { session_id: 'S1' } } as any;
    const task = { taskId: 'T1' } as any;

    const p = runPromptTurn({ client, agent, task, sessionId: 'S1', readOnly: false, body });
    await tick(); // reaches `await turn`
    turnCompletion.appendText('S1', 'po');
    turnCompletion.appendText('S1', 'ng');
    turnCompletion.completeTurn('S1'); // simulate session.idle

    const { reply, sessionId } = await p;
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(sessionId).toBe('S1');
    expect(reply).toBe('pong');
  });

  it('resets the session and retries once on a not-found promptAsync result', async () => {
    const promptAsync = vi.fn()
      .mockResolvedValueOnce({ error: { name: 'NotFoundError', data: { message: 'Session not found: S1' } } })
      .mockResolvedValueOnce({ data: {} }); // 204 on the fresh session
    const create = vi.fn().mockResolvedValue({ data: { id: 'S2' } });
    const client = { session: { promptAsync, create } } as any;
    const agent = { def: { id: 'pm' }, session: { session_id: 'S1' } } as any;
    const task = { taskId: 'T1' } as any;

    const p = runPromptTurn({ client, agent, task, sessionId: 'S1', readOnly: false, body });
    await tick();
    turnCompletion.completeTurn('S2'); // idle for the fresh session

    const { sessionId } = await p;
    expect(create).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(sessionId).toBe('S2');
    expect(agent.session.session_id).toBe('S2'); // outer recovery re-spawn starts fresh
  });

  it('gives up (throws) after a second not-found — bounded to one retry', async () => {
    const promptAsync = vi.fn().mockResolvedValue({ error: { name: 'NotFoundError', data: { message: 'Session not found' } } });
    const create = vi.fn().mockResolvedValue({ data: { id: 'S2' } });
    const client = { session: { promptAsync, create } } as any;
    const agent = { def: { id: 'pm' }, session: { session_id: 'S1' } } as any;
    const task = { taskId: 'T1' } as any;

    await expect(
      runPromptTurn({ client, agent, task, sessionId: 'S1', readOnly: false, body }),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(2); // initial + one retry, then give up
  });

  it('surfaces a non-not-found promptAsync error without recovering', async () => {
    const promptAsync = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    const create = vi.fn();
    const client = { session: { promptAsync, create } } as any;
    const agent = { def: { id: 'pm' }, session: { session_id: 'S1' } } as any;
    const task = { taskId: 'T1' } as any;

    await expect(
      runPromptTurn({ client, agent, task, sessionId: 'S1', readOnly: false, body }),
    ).rejects.toThrow('ECONNRESET');
    expect(create).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(agent.session.session_id).toBe('S1'); // untouched — not a stale session
  });

  it('rejects when the turn errors (session.error)', async () => {
    const promptAsync = vi.fn().mockResolvedValue({ data: {} });
    const client = { session: { promptAsync, create: vi.fn() } } as any;
    const agent = { def: { id: 'pm' }, session: { session_id: 'S1' } } as any;
    const task = { taskId: 'T1' } as any;

    const p = runPromptTurn({ client, agent, task, sessionId: 'S1', readOnly: false, body });
    await tick();
    turnCompletion.failTurn('S1', new Error('provider error')); // simulate session.error

    await expect(p).rejects.toThrow('provider error');
  });
});
