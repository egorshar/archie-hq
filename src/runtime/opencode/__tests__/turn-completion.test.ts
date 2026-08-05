/**
 * Turn-completion registry — bridges the async opencode turn (fired via
 * session.promptAsync, which returns immediately) to the SSE session.idle /
 * session.error events that signal the turn actually finished. Replaces the
 * blocking session.prompt whose held-open HTTP request hit undici's headers
 * timeout on long turns (2026-07-10).
 */
import { describe, it, expect, vi } from 'vitest';
import { TurnCompletionRegistry } from '../turn-completion.js';

describe('TurnCompletionRegistry', () => {
  it('resolves with accumulated text on completeTurn (idle)', async () => {
    const reg = new TurnCompletionRegistry();
    const turn = reg.waitForTurn('S1');
    reg.appendText('S1', 'pon');
    reg.appendText('S1', 'g');
    reg.completeTurn('S1');
    await expect(turn).resolves.toBe('pong');
  });

  it('rejects on failTurn (session.error)', async () => {
    const reg = new TurnCompletionRegistry();
    const turn = reg.waitForTurn('S1');
    reg.failTurn('S1', new Error('provider blew up'));
    await expect(turn).rejects.toThrow('provider blew up');
  });

  it('resolves empty on cancelTurn (abort/reset — deliberate discard)', async () => {
    const reg = new TurnCompletionRegistry();
    const turn = reg.waitForTurn('S1');
    reg.appendText('S1', 'partial');
    reg.cancelTurn('S1', 'aborted');
    await expect(turn).resolves.toBe('');
  });

  it('ignores idle/error/text for an unregistered session (no throw)', () => {
    const reg = new TurnCompletionRegistry();
    expect(() => reg.appendText('nope', 'x')).not.toThrow();
    expect(() => reg.completeTurn('nope')).not.toThrow();
    expect(() => reg.failTurn('nope', new Error('x'))).not.toThrow();
    expect(() => reg.cancelTurn('nope', 'x')).not.toThrow();
  });

  it('is per-session: one session completing does not affect another', async () => {
    const reg = new TurnCompletionRegistry();
    const a = reg.waitForTurn('A');
    const b = reg.waitForTurn('B');
    reg.appendText('A', 'aaa');
    reg.completeTurn('A');
    await expect(a).resolves.toBe('aaa');
    reg.appendText('B', 'bbb');
    reg.completeTurn('B');
    await expect(b).resolves.toBe('bbb');
  });

  it('supersedes a pending waiter if the same session starts a new turn', async () => {
    const reg = new TurnCompletionRegistry();
    const first = reg.waitForTurn('S1');
    const second = reg.waitForTurn('S1'); // supersedes `first`
    reg.completeTurn('S1');
    await expect(first).resolves.toBe(''); // superseded → resolved empty, no dangling promise
    await expect(second).resolves.toBe('');
  });
});

/**
 * Step budget (maxTurns). opencode drives a turn to `session.idle` with no cap
 * of its own, so an agent that keeps calling tools runs until it decides to
 * stop — one research brief reached 139 API round-trips. The budget counts
 * assistant messages (one per round-trip) and ends the turn when the agent
 * spends more than its allowance.
 */
describe('TurnCompletionRegistry step budget', () => {
  it('trips once when a turn spends more steps than its budget, and rejects the waiter', async () => {
    const reg = new TurnCompletionRegistry();
    const turn = reg.waitForTurn('S1', 2);
    expect(reg.noteAssistantStep('S1', 'm1')).toBe(false);
    expect(reg.noteAssistantStep('S1', 'm2')).toBe(false); // budget spent, not exceeded
    expect(reg.noteAssistantStep('S1', 'm3')).toBe(true); // over budget → end the turn
    await expect(turn).rejects.toThrow(/step budget|maxTurns/i);
    // Only the first breach asks the caller to abort — the session is aborted once.
    expect(reg.noteAssistantStep('S1', 'm4')).toBe(false);
  });

  it('counts one step per assistant message, however often it is updated', async () => {
    const reg = new TurnCompletionRegistry();
    const turn = reg.waitForTurn('S1', 2);
    for (const id of ['m1', 'm1', 'm1', 'm2', 'm2']) reg.noteAssistantStep('S1', id);
    expect(reg.noteAssistantStep('S1', 'm2')).toBe(false); // still two distinct steps
    expect(reg.noteAssistantStep('S1', 'm3')).toBe(true);
    await expect(turn).rejects.toThrow(/step budget|maxTurns/i);
  });

  it('never trips when the turn was registered without a budget', async () => {
    const reg = new TurnCompletionRegistry();
    const turn = reg.waitForTurn('S1');
    for (let i = 0; i < 500; i++) expect(reg.noteAssistantStep('S1', `m${i}`)).toBe(false);
    reg.completeTurn('S1');
    await expect(turn).resolves.toBe('');
  });

  it('gives each turn a fresh budget — a spent turn does not starve the next brief', async () => {
    const reg = new TurnCompletionRegistry();
    const first = reg.waitForTurn('S1', 1);
    reg.noteAssistantStep('S1', 'm1');
    expect(reg.noteAssistantStep('S1', 'm2')).toBe(true);
    await expect(first).rejects.toThrow(/step budget|maxTurns/i);

    const second = reg.waitForTurn('S1', 1);
    expect(reg.noteAssistantStep('S1', 'm3')).toBe(false); // budget starts over
    reg.completeTurn('S1');
    await expect(second).resolves.toBe('');
  });

  it('ignores steps for an unregistered session (no throw)', () => {
    const reg = new TurnCompletionRegistry();
    expect(() => reg.noteAssistantStep('nope', 'm1')).not.toThrow();
    expect(reg.noteAssistantStep('nope', 'm1')).toBe(false);
  });
});
