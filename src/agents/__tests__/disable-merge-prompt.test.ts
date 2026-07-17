import { describe, it, expect, afterEach } from 'vitest';
import { mergeDisabledNote } from '../spawn.js';

const KEY = 'ARCHIE_DISABLE_MERGE';
afterEach(() => { delete process.env[KEY]; });

describe('mergeDisabledNote', () => {
  it('is empty when merge is enabled', () => {
    delete process.env[KEY];
    expect(mergeDisabledNote()).toBe('');
  });
  it('tells the agent not to merge when disabled', () => {
    process.env[KEY] = 'true';
    const note = mergeDisabledNote();
    expect(note.toLowerCase()).toContain('merging is disabled');
    expect(note.toLowerCase()).toContain('do not');
  });
});
