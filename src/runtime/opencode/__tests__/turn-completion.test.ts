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
