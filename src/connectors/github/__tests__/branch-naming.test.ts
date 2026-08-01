/**
 * Unit tests for repo-agent branch naming and task-ID extraction.
 *
 * These lock in the migration contract: new branches use the `archie/` prefix,
 * while the webhook parser keeps attributing branches with the legacy `feature/`
 * prefix so historical PRs continue routing to their task.
 */

import { describe, it, expect } from 'vitest';
import {
  BRANCH_PREFIX,
  taskBranchName,
  extractTaskIdFromBranch,
  composeTicketBranchName,
} from '../branch-naming.js';

const TASK_ID = 'task-20260101-1823-abc123';

describe('taskBranchName', () => {
  it('uses the archie prefix for the first branch', () => {
    expect(taskBranchName(TASK_ID)).toBe(`archie/${TASK_ID}`);
    expect(BRANCH_PREFIX).toBe('archie');
  });

  it('auto-numbers additional branches', () => {
    expect(taskBranchName(TASK_ID, 1)).toBe(`archie/${TASK_ID}-2`);
    expect(taskBranchName(TASK_ID, 2)).toBe(`archie/${TASK_ID}-3`);
  });
});

describe('extractTaskIdFromBranch', () => {
  it('extracts the task ID from a new archie/ branch', () => {
    expect(extractTaskIdFromBranch(`archie/${TASK_ID}`)).toBe(TASK_ID);
  });

  it('extracts the task ID from a legacy feature/ branch (backward compat)', () => {
    expect(extractTaskIdFromBranch(`feature/${TASK_ID}`)).toBe(TASK_ID);
  });

  it('handles the multi-branch suffix for both prefixes', () => {
    expect(extractTaskIdFromBranch(`archie/${TASK_ID}-2`)).toBe(TASK_ID);
    expect(extractTaskIdFromBranch(`feature/${TASK_ID}-3`)).toBe(TASK_ID);
  });

  it('round-trips generated branch names', () => {
    expect(extractTaskIdFromBranch(taskBranchName(TASK_ID))).toBe(TASK_ID);
    expect(extractTaskIdFromBranch(taskBranchName(TASK_ID, 4))).toBe(TASK_ID);
  });

  it('returns undefined for unrelated or malformed branches', () => {
    expect(extractTaskIdFromBranch(undefined)).toBeUndefined();
    expect(extractTaskIdFromBranch('main')).toBeUndefined();
    expect(extractTaskIdFromBranch('archie/not-a-task')).toBeUndefined();
    expect(extractTaskIdFromBranch(`release/${TASK_ID}`)).toBeUndefined();
  });
});

describe('composeTicketBranchName', () => {
  it('composes feature/<TICKET> by default', () => {
    expect(composeTicketBranchName({ ticket: 'PROJ-123' })).toBe('feature/PROJ-123');
  });

  it('supports release and hotfix types', () => {
    expect(composeTicketBranchName({ ticket: 'PROJ-123', type: 'release' })).toBe('release/PROJ-123');
    expect(composeTicketBranchName({ ticket: 'PROJ-123', type: 'hotfix' })).toBe('hotfix/PROJ-123');
  });

  it('uppercases the ticket key', () => {
    expect(composeTicketBranchName({ ticket: 'proj-123' })).toBe('feature/PROJ-123');
  });

  it('kebab-cases the slug and appends it', () => {
    expect(composeTicketBranchName({ ticket: 'PROJ-123', slug: 'Fix Auth Flow!' })).toBe('feature/PROJ-123-fix-auth-flow');
    expect(composeTicketBranchName({ ticket: 'PROJ-123', slug: '--weird__chars//here--' })).toBe('feature/PROJ-123-weird-chars-here');
  });

  it('caps the slug at 48 chars without a trailing dash', () => {
    const long = 'a'.repeat(40) + ' ' + 'b'.repeat(40);
    const name = composeTicketBranchName({ ticket: 'PROJ-123', slug: long });
    const slug = name.replace('feature/PROJ-123-', '');
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('rejects malformed tickets with an actionable message', () => {
    expect(() => composeTicketBranchName({ ticket: 'PROJ' })).toThrow(/PROJ-123/);
    expect(() => composeTicketBranchName({ ticket: '123-PROJ' })).toThrow(/PROJ-123/);
    expect(() => composeTicketBranchName({ ticket: '' })).toThrow(/PROJ-123/);
  });

  it('rejects a slug that sanitizes to empty', () => {
    expect(() => composeTicketBranchName({ ticket: 'PROJ-123', slug: '!!!' })).toThrow(/slug/i);
  });

  it('does not parse as a task branch (attribution stays on the scan path)', () => {
    expect(extractTaskIdFromBranch('feature/PROJ-123')).toBeUndefined();
    expect(extractTaskIdFromBranch('feature/PROJ-123-fix-auth-flow')).toBeUndefined();
  });
});
