import { describe, it, expect } from 'vitest';
import { captureRequester } from '../requested-by.js';

describe('captureRequester', () => {
  const slack = { id: 'U1', realName: 'Egor Sharapov', username: 'egor' } as any;
  it('captures a slack human on first message', () => {
    expect(captureRequester(undefined, { kind: 'slack', author: slack }))
      .toEqual({ id: 'U1', name: 'Egor Sharapov', source: 'slack' });
  });
  it('captures cli', () => {
    expect(captureRequester(undefined, { kind: 'cli' }))
      .toEqual({ id: 'cli', name: 'cli', source: 'cli' });
  });
  it('is set-once (keeps the existing requester)', () => {
    const existing = { id: 'U1', name: 'Egor Sharapov', source: 'slack' as const };
    expect(captureRequester(existing, { kind: 'cli' })).toBe(existing);
  });
});
