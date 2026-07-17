import { describe, it, expect, afterEach } from 'vitest';
import { isMergeDisabled, getBackendMatrix } from '../backends.js';

const KEY = 'ARCHIE_DISABLE_MERGE';
afterEach(() => { delete process.env[KEY]; });

describe('isMergeDisabled', () => {
  it('is false when unset/empty/non-truthy', () => {
    delete process.env[KEY];
    expect(isMergeDisabled()).toBe(false);
    for (const v of ['', '0', 'false', 'no', 'off', 'nope']) {
      process.env[KEY] = v;
      expect(isMergeDisabled()).toBe(false);
    }
  });
  it('is true for truthy values (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      process.env[KEY] = v;
      expect(isMergeDisabled()).toBe(true);
    }
  });
  it('surfaces in the backend matrix', () => {
    delete process.env[KEY];
    expect(getBackendMatrix().merge).toBe('enabled');
    process.env[KEY] = 'true';
    expect(getBackendMatrix().merge).toBe('disabled');
  });
});
