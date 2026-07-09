import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above these imports; a plain top-level
// `vi.fn()` referenced inside one throws "Cannot access before initialization"
// under this vitest version, so the mock fns are created inside vi.hoisted
// (same pattern as llm-one-shot.test.ts).
const { getOpencodeClient } = vi.hoisted(() => ({ getOpencodeClient: vi.fn() }));
vi.mock('../server.js', () => ({
  getOpencodeClient,
  concatPromptText: (res: any) => {
    const parts = res?.data?.parts ?? [];
    const t = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
    return t || null;
  },
}));
vi.mock('../model.js', () => ({
  resolveOpencodeModel: (m: string) => ({ providerID: 'anthropic', modelID: m }),
}));
vi.mock('../../../agents/spawn.js', () => ({
  prepareAgentContext: vi.fn(async (agent: any) => {
    agent.sandbox = { cwd: '/w' };
    return { systemPrompt: 'SYS', cwd: '/w', additionalDirectories: [], sandboxOpts: { cwd: '/w' } };
  }),
}));

import { MessageQueue } from '../../../agents/message-queue.js';
import { OpencodeRuntime } from '../runtime.js';

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
  let prompt: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    create = vi.fn(async () => ({ data: { id: 'sess-1' } }));
    prompt = vi.fn(async () => ({ data: { parts: [{ type: 'text', text: 'hi there' }] } }));
    getOpencodeClient.mockResolvedValue({ session: { create, prompt } });
  });

  it('creates a session, prompts with the resolved model + system prompt, sets a live handle', async () => {
    const agent = makeAgent();
    const task = makeTask();
    await new OpencodeRuntime().spawn(agent as any, task as any);

    expect(agent.handle).toBeTruthy();
    expect(agent.handle.isRunning).toBe(true);
    expect(agent.sandbox).toEqual({ cwd: '/w' });

    agent.queue.addMessage('investigate the login bug', 'alice');
    await new Promise((r) => setTimeout(r, 0));

    expect(create).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    const body = prompt.mock.calls[0][0].body;
    expect(body.model).toEqual({ providerID: 'anthropic', modelID: 'opus' });
    expect(body.system).toBe('SYS');
    expect(body.parts[0].text).toContain('investigate the login bug');
    // first response marks active with the session id, then idle marks inactive
    expect(task.updateAgentState).toHaveBeenCalledWith('pm', true, 'sess-1');
    expect(task.updateAgentState).toHaveBeenCalledWith('pm', false);
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
  });

  it('abort() cancels via the AbortController signal', async () => {
    const agent = makeAgent();
    const task = makeTask();
    let seenSignal: AbortSignal | undefined;
    prompt.mockImplementation(async (req: any) => {
      seenSignal = req?.signal;
      return { data: { parts: [{ type: 'text', text: 'ok' }] } };
    });
    await new OpencodeRuntime().spawn(agent as any, task as any);
    agent.queue.addMessage('go');
    await new Promise((r) => setTimeout(r, 0));
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);
    agent.handle.abort();
    expect(seenSignal!.aborted).toBe(true);
  });
});
