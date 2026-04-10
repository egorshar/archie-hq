/**
 * Memory Paths
 *
 * All path resolution for memory artifacts.
 * Uses WORKDIR from core but owns the memory/ subtree.
 */

import { join } from 'path';
import { WORKDIR } from '../system/workdir.js';

/** Feature flag: set ARCHIE_MEMORY=false to disable */
export function isMemoryEnabled(): boolean {
  return process.env.ARCHIE_MEMORY !== 'false';
}

/** Root memory directory: workdir/memory/ */
export function getMemoryDir(): string {
  return join(WORKDIR, 'memory');
}

/** Org knowledge file: workdir/memory/org.md */
export function getOrgPath(): string {
  return join(getMemoryDir(), 'org.md');
}

/** Users directory: workdir/memory/users/ */
export function getUsersDir(): string {
  return join(getMemoryDir(), 'users');
}

/** Per-user file: workdir/memory/users/{username}.md */
export function getUserPath(username: string): string {
  // Sanitize: lowercase, alphanumeric + hyphens only
  const safe = username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return join(getUsersDir(), `${safe}.md`);
}

/** Recent activity index: workdir/memory/recent-activity.md */
export function getRecentActivityPath(): string {
  return join(getMemoryDir(), 'recent-activity.md');
}

/** Task summary path: workdir/sessions/{taskId}/shared/summary.md */
export function getTaskSummaryPath(taskId: string): string {
  return join(WORKDIR, 'sessions', taskId, 'shared', 'summary.md');
}
