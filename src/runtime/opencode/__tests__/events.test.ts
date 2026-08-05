import { describe, it, expect, vi } from 'vitest';
import { handleOpencodeEvent } from '../events.js';
import { SessionRegistry } from '../bridge/registry.js';
import { turnCompletion } from '../turn-completion.js';

function registryWith(sessionId: string) {
  const reg = new SessionRegistry();
  const noteActivity = vi.fn();
  const task = { noteActivity } as any;
  const agent = { def: { id: 'backend-agent' } } as any;
  reg.set(sessionId, { task, agent, readOnly: false });
  return { reg, noteActivity };
}

describe('handleOpencodeEvent', () => {
  it('routes a tool part to noteActivity with the agent id + tool name', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'S1', tool: 'read', state: { input: { filePath: 'a.ts' } } } } },
      reg,
    );
    expect(noteActivity).toHaveBeenCalledWith('backend-agent', 'read', { filePath: 'a.ts' });
  });

  it('prefixes bridged repo-tool bare names to the mcp__repo-tools__ form', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'S1', tool: 'push_branch', state: {} } } },
      reg,
    );
    expect(noteActivity).toHaveBeenCalledWith('backend-agent', 'mcp__repo-tools__push_branch', {});
  });

  it('prefixes every repo tool derived from REPO_TOOL_SPECS (anti-drift, e.g. code-scanning)', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'S1', tool: 'list_code_scanning_alerts', state: {} } } },
      reg,
    );
    expect(noteActivity).toHaveBeenCalledWith('backend-agent', 'mcp__repo-tools__list_code_scanning_alerts', {});
  });

  it('ignores events for unknown sessions', () => {
    const { reg, noteActivity } = registryWith('S1');
    handleOpencodeEvent(
      { type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 'OTHER', tool: 'read', state: {} } } },
      reg,
    );
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('ignores non-tool parts and session.idle (no throw, no note)', () => {
    const { reg, noteActivity } = registryWith('S1');
    expect(() => handleOpencodeEvent({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'S1', text: 'hi' } } }, reg)).not.toThrow();
    expect(() => handleOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'S1' } }, reg)).not.toThrow();
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('never throws on a malformed event', () => {
    const { reg } = registryWith('S1');
    expect(() => handleOpencodeEvent(null, reg)).not.toThrow();
    expect(() => handleOpencodeEvent({}, reg)).not.toThrow();
    expect(() => handleOpencodeEvent({ type: 'message.part.updated' }, reg)).not.toThrow();
  });
});

/**
 * Step budget: each assistant message is one API round-trip, so the consumer
 * counts them and asks the caller to abort the session once a turn spends more
 * than the agent's allowance. Aborting server-side is the point — rejecting the
 * waiter alone would leave opencode running the turn, still spending tokens.
 */
describe('handleOpencodeEvent step budget', () => {
  const assistantMessage = (sessionID: string, id: string) => ({
    type: 'message.updated',
    properties: { info: { id, sessionID, role: 'assistant' } },
  });

  it('aborts the session when a turn runs past its step budget', async () => {
    const { reg } = registryWith('S1');
    const abortSession = vi.fn();
    const turn = turnCompletion.waitForTurn('S1', 2);

    handleOpencodeEvent(assistantMessage('S1', 'm1'), reg, abortSession);
    handleOpencodeEvent(assistantMessage('S1', 'm2'), reg, abortSession);
    expect(abortSession).not.toHaveBeenCalled();

    handleOpencodeEvent(assistantMessage('S1', 'm3'), reg, abortSession);
    expect(abortSession).toHaveBeenCalledExactlyOnceWith('S1');
    await expect(turn).rejects.toThrow(/step budget|maxTurns/i);
  });

  it('does not count the user message that opened the turn', () => {
    const { reg } = registryWith('S1');
    const abortSession = vi.fn();
    const turn = turnCompletion.waitForTurn('S1', 1);
    handleOpencodeEvent({ type: 'message.updated', properties: { info: { id: 'u1', sessionID: 'S1', role: 'user' } } }, reg, abortSession);
    handleOpencodeEvent({ type: 'message.updated', properties: { info: { id: 'u2', sessionID: 'S1', role: 'user' } } }, reg, abortSession);
    expect(abortSession).not.toHaveBeenCalled();
    turnCompletion.cancelTurn('S1', 'test cleanup');
    return expect(turn).resolves.toBe('');
  });

  it('counts steps for a session the status registry does not know (still budgeted)', async () => {
    const reg = new SessionRegistry(); // nothing registered — no status line for this session
    const abortSession = vi.fn();
    const turn = turnCompletion.waitForTurn('S9', 1);
    handleOpencodeEvent(assistantMessage('S9', 'm1'), reg, abortSession);
    handleOpencodeEvent(assistantMessage('S9', 'm2'), reg, abortSession);
    expect(abortSession).toHaveBeenCalledExactlyOnceWith('S9');
    await expect(turn).rejects.toThrow(/step budget|maxTurns/i);
  });

  it('never throws on a malformed message.updated, or with no abort callback wired', () => {
    const { reg } = registryWith('S1');
    expect(() => handleOpencodeEvent({ type: 'message.updated' }, reg, vi.fn())).not.toThrow();
    expect(() => handleOpencodeEvent({ type: 'message.updated', properties: {} }, reg, vi.fn())).not.toThrow();
    expect(() => handleOpencodeEvent(assistantMessage('S1', 'm1'), reg)).not.toThrow();
  });
});
