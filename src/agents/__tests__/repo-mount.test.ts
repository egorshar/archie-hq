/**
 * Mount selection for repo agents (lazy repo mounting).
 *
 * Pure-function level: selectReposToMount decides which declared repos a
 * spawn mounts, given the task's attachment records. The invariants under
 * test are the compatibility guarantees: no attachments → eager (unchanged
 * legacy behavior); PM-attached subset → only that subset; stale attachments
 * never produce a zero-repo spawn.
 */

import { describe, it, expect } from 'vitest';
import type { RepoEntry } from '../../types/agent.js';
import { selectReposToMount } from '../repo-mount.js';

const entry = (github: string): RepoEntry => ({
  github,
  baseBranch: 'main',
  autoMerge: false,
});

const declared = [entry('org/server'), entry('org/portal'), entry('org/core')];

describe('selectReposToMount', () => {
  it('mounts every declared repo when the task has no attachments (eager default)', () => {
    expect(selectReposToMount(declared, [])).toEqual(declared);
  });

  it('mounts only the attached subset when the PM pre-attached repos', () => {
    expect(selectReposToMount(declared, ['org/portal'])).toEqual([entry('org/portal')]);
    expect(selectReposToMount(declared, ['org/core', 'org/server'])).toEqual([
      entry('org/server'),
      entry('org/core'),
    ]);
  });

  it('ignores attached repos that are no longer declared (frontmatter is the allowlist)', () => {
    expect(selectReposToMount(declared, ['org/portal', 'org/removed'])).toEqual([
      entry('org/portal'),
    ]);
  });

  it('falls back to eager when every attachment is stale — never a zero-repo spawn', () => {
    expect(selectReposToMount(declared, ['org/removed', 'org/retired'])).toEqual(declared);
  });

  it('is a no-op narrowing after an eager spawn attached the full list', () => {
    expect(selectReposToMount(declared, declared.map((d) => d.github))).toEqual(declared);
  });
});
