import { describe, it, expect, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ getCalls: 0 }));
vi.mock('../../../tasks/task.js', () => ({
  Task: { get: async () => { state.getCalls++; return {} as any; } },
}));

import { triggerMergeCheck } from '../merge.js';

const KEY = 'ARCHIE_DISABLE_MERGE';
afterEach(() => { delete process.env[KEY]; state.getCalls = 0; });

describe('merge executor honors ARCHIE_DISABLE_MERGE', () => {
  it('triggerMergeCheck no-ops (never loads the task) when disabled', async () => {
    process.env[KEY] = 'true';
    const res = await triggerMergeCheck('task-1');
    expect(state.getCalls).toBe(0);
    expect(res).toEqual({ merged: [], pending: [], conflicts: [], ready: [] });
  });
});
