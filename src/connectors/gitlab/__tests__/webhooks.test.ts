import { describe, it, expect } from 'vitest';
import { formatGitLabContext, verifyGitLabToken, extractBranchFromPayload } from '../webhooks.js';
import { determineRouteAction } from '../../shared/cr-router.js';

describe('verifyGitLabToken', () => {
  it('accepts a matching token, rejects a mismatch, rejects wrong length', () => {
    expect(verifyGitLabToken('secret', 'secret')).toBe(true);
    expect(verifyGitLabToken('secret', 'nope')).toBe(false);
    expect(verifyGitLabToken('secret', '')).toBe(false);
    expect(verifyGitLabToken(undefined, 'secret')).toBe(false);
  });
});

describe('formatGitLabContext → canonical vocabulary', () => {
  const project = { path_with_namespace: 'grp/proj' };
  const user = { username: 'dev1' };

  it('MR open → pull_request/opened → merge_check', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'open', source_branch: 'feat/x', state: 'opened' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request', action: 'opened', repo: 'grp/proj', prNumber: 5, branch: 'feat/x', user: 'dev1' });
    expect(determineRouteAction(ctx)).toBe('merge_check');
  });

  it('MR update → pull_request/synchronize → merge_check', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'update', source_branch: 'feat/x' },
    });
    expect(ctx.action).toBe('synchronize');
    expect(determineRouteAction(ctx)).toBe('merge_check');
  });

  it('MR merge → pull_request/closed state merged → existing_task', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'merge', source_branch: 'feat/x' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request', action: 'closed', state: 'merged' });
    expect(determineRouteAction(ctx)).toBe('existing_task');
  });

  it('MR approved → pull_request_review approved → merge_check', () => {
    const ctx = formatGitLabContext('merge_request', {
      object_kind: 'merge_request', project, user,
      object_attributes: { iid: 5, action: 'approved', source_branch: 'feat/x' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request_review', state: 'approved' });
    expect(determineRouteAction(ctx)).toBe('merge_check');
  });

  it('note on MR diff → pull_request_review_comment → existing_task', () => {
    const ctx = formatGitLabContext('note', {
      object_kind: 'note', project, user,
      merge_request: { iid: 9, source_branch: 'feat/y' },
      object_attributes: { id: 321, noteable_type: 'MergeRequest', type: 'DiffNote', note: 'fix this' },
    });
    expect(ctx).toMatchObject({ eventType: 'pull_request_review_comment', prNumber: 9, commentId: 321 });
    expect(determineRouteAction(ctx)).toBe('existing_task');
  });

  it('plain note on MR → issue_comment/created → existing_task', () => {
    const ctx = formatGitLabContext('note', {
      object_kind: 'note', project, user,
      merge_request: { iid: 9, source_branch: 'feat/y' },
      object_attributes: { id: 322, noteable_type: 'MergeRequest', note: 'thoughts?' },
    });
    expect(ctx).toMatchObject({ eventType: 'issue_comment', action: 'created', prNumber: 9, commentId: 322 });
    expect(determineRouteAction(ctx)).toBe('existing_task');
  });

  it('push → push → merge_check; branch stripped from ref', () => {
    const ctx = formatGitLabContext('push', { object_kind: 'push', project, user, ref: 'refs/heads/feat/z' });
    expect(ctx).toMatchObject({ eventType: 'push', branch: 'feat/z' });
    expect(determineRouteAction(ctx)).toBe('merge_check');
  });

  it('pipeline success → workflow_run completed success → merge_check', () => {
    const ctx = formatGitLabContext('pipeline', {
      object_kind: 'pipeline', project, user,
      object_attributes: { ref: 'feat/z', status: 'success' },
      merge_request: { iid: 12 },
    });
    expect(ctx).toMatchObject({ eventType: 'workflow_run', action: 'completed', state: 'success', prNumber: 12 });
    expect(determineRouteAction(ctx)).toBe('merge_check');
  });

  it('pipeline failed → workflow_run completed failure → existing_task', () => {
    const ctx = formatGitLabContext('pipeline', {
      object_kind: 'pipeline', project, user,
      object_attributes: { ref: 'feat/z', status: 'failed' },
    });
    expect(ctx).toMatchObject({ eventType: 'workflow_run', action: 'completed', state: 'failure' });
    expect(determineRouteAction(ctx)).toBe('existing_task');
  });
});

describe('extractBranchFromPayload', () => {
  it('pulls the branch from MR / push / pipeline payloads', () => {
    expect(extractBranchFromPayload('merge_request', { object_attributes: { source_branch: 'feat/a' } })).toBe('feat/a');
    expect(extractBranchFromPayload('push', { ref: 'refs/heads/feat/b' })).toBe('feat/b');
    expect(extractBranchFromPayload('pipeline', { object_attributes: { ref: 'feat/c' } })).toBe('feat/c');
    expect(extractBranchFromPayload('note', { merge_request: { source_branch: 'feat/d' } })).toBe('feat/d');
  });
});
