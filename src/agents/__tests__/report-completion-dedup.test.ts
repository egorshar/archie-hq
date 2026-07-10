/**
 * report_completion double-post backstop (opencode-only).
 *
 * A weaker opencode model sometimes posts its answer via post_to_user and THEN
 * passes a redundant "task completed" summary to report_completion. When a
 * user-facing message already went out this turn, reportCompletionHandler drops
 * the redundant message and finishes silently — but ONLY under AGENT_RUNTIME=
 * opencode. The Claude path is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportCompletionHandler } from '../tools.js';

function makeTask() {
  return {
    isActive: true,
    completionIntent: false,
    metadata: { channels: { 'slack:C:1': { type: 'slack' } } },
    postToUser: vi.fn().mockResolvedValue(null),
    touch: vi.fn(),
    resurfacePrCards: vi.fn().mockResolvedValue(undefined),
    suspendStatus: vi.fn(),
    setCompletionIntent: vi.fn(),
  } as any;
}
function makeAgent(postedToUserThisTurn: boolean) {
  return { def: { id: 'pm-agent' }, pendingTeardown: undefined, postedToUserThisTurn } as any;
}

const prev = process.env.AGENT_RUNTIME;
beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { if (prev === undefined) delete process.env.AGENT_RUNTIME; else process.env.AGENT_RUNTIME = prev; });

describe('reportCompletionHandler double-post backstop', () => {
  it('opencode: drops the message when a user post already fired this turn', async () => {
    process.env.AGENT_RUNTIME = 'opencode';
    const task = makeTask();
    const agent = makeAgent(true);
    const res = await reportCompletionHandler(agent, task, { message: 'Task completed - listed the agents.' });
    expect(task.postToUser).not.toHaveBeenCalled();       // redundant message suppressed
    expect(task.setCompletionIntent).toHaveBeenCalledTimes(1); // still completes
    expect(res.content[0].text).toContain('Completion recorded');
  });

  it('opencode: posts the message when nothing was posted yet this turn', async () => {
    process.env.AGENT_RUNTIME = 'opencode';
    const task = makeTask();
    const agent = makeAgent(false);
    await reportCompletionHandler(agent, task, { message: 'Here is the answer.' });
    expect(task.postToUser).toHaveBeenCalledWith('Here is the answer.', 'pm-agent');
    expect(task.setCompletionIntent).toHaveBeenCalledTimes(1);
  });

  it('claude: never suppresses, even after a user post this turn', async () => {
    process.env.AGENT_RUNTIME = 'claude';
    const task = makeTask();
    const agent = makeAgent(true);
    await reportCompletionHandler(agent, task, { message: 'Final answer.' });
    expect(task.postToUser).toHaveBeenCalledWith('Final answer.', 'pm-agent');
  });
});
