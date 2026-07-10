/**
 * opencode double-post dedup lives entirely in the bridge (the shared tool
 * handlers and the core Agent are runtime-agnostic). A weaker opencode model
 * sometimes posts its answer via `post_to_user` AND passes a redundant "task
 * completed" summary to `report_completion`. `markUserPost` records a
 * successful post for the turn; `scrubRedundantCompletion` then strips
 * `report_completion`'s message so the answer isn't delivered twice (completion
 * itself is still recorded by the shared handler).
 */
import { describe, it, expect } from 'vitest';
import { markUserPost, scrubRedundantCompletion } from '../server.js';
import type { BridgeSession } from '../registry.js';

function session(over: Partial<BridgeSession> = {}): BridgeSession {
  return { task: {} as any, agent: {} as any, readOnly: false, ...over };
}
const result = (text: string) => ({ content: [{ type: 'text' as const, text }] });

describe('markUserPost', () => {
  it('flags the session on a successful post', () => {
    const s = session();
    markUserPost(s, result('Message posted.'));
    expect(s.postedThisTurn).toBe(true);
  });

  it('flags on the new-channel success variant too', () => {
    const s = session();
    markUserPost(s, result('Message posted. New channel linked: C123 (saved in task metadata for future use)'));
    expect(s.postedThisTurn).toBe(true);
  });

  it('does NOT flag on a send-error result (only successful posts count)', () => {
    const s = session();
    markUserPost(s, result('Could not send the Slack message: channel_not_found'));
    expect(s.postedThisTurn).toBeFalsy();
  });
});

describe('scrubRedundantCompletion', () => {
  it('strips the message once a user post already fired this turn', () => {
    const s = session({ postedThisTurn: true });
    expect(scrubRedundantCompletion(s, { message: 'redundant summary' })).toEqual({ message: undefined });
  });

  it('leaves args untouched when no post fired this turn (the answer must still go out)', () => {
    const s = session({ postedThisTurn: false });
    const args = { message: 'here is the answer' };
    expect(scrubRedundantCompletion(s, args)).toBe(args);
  });

  it('leaves a no-message completion untouched', () => {
    const s = session({ postedThisTurn: true });
    const args = {};
    expect(scrubRedundantCompletion(s, args)).toBe(args);
  });
});
