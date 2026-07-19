import { describe, it, expect } from 'vitest';
import { safePathSegment } from '../path-safety.js';

describe('safePathSegment', () => {
  it('returns a valid single segment unchanged', () => {
    expect(safePathSegment('task-20260623-1823-21ib4k-3', 'taskId')).toBe('task-20260623-1823-21ib4k-3');
    expect(safePathSegment('backend', 'agentId')).toBe('backend');
    expect(safePathSegment('mobile-agent')).toBe('mobile-agent');
  });

  it('rejects path separators', () => {
    expect(() => safePathSegment('a/b', 'taskId')).toThrow(/Unsafe taskId/);
    expect(() => safePathSegment('..\\etc')).toThrow(/Unsafe/);
  });

  it('rejects traversal and relative segments', () => {
    expect(() => safePathSegment('..')).toThrow(/Unsafe/);
    expect(() => safePathSegment('.')).toThrow(/Unsafe/);
    expect(() => safePathSegment('../../etc/passwd', 'taskId')).toThrow(/Unsafe taskId/);
  });

  it('rejects empty and NUL-bearing values', () => {
    expect(() => safePathSegment('')).toThrow(/Unsafe/);
    expect(() => safePathSegment('a\0b')).toThrow(/Unsafe/);
  });
});
