import { basename } from 'node:path';

/**
 * Validate that `segment` is a single, safe path component and return it.
 *
 * Throws on empty, separator-bearing, traversal (`.`/`..`), or NUL-bearing
 * values. Use at the point where an externally-influenced identifier (e.g. a
 * task id that originates from an API route param, an agent id, a session key)
 * is about to be concatenated into a filesystem path, so a crafted value like
 * `../../etc` can't redirect the path outside its intended parent. The return
 * value is routed through `basename()` (a no-op for an already-valid segment)
 * so the neutralization is also visible to static taint analysis.
 */
export function safePathSegment(segment: string, label = 'path segment'): string {
  const base = basename(segment);
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('\0') ||
    segment.includes('/') ||
    segment.includes('\\') ||
    base !== segment
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(segment)}`);
  }
  return base;
}
