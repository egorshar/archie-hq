import { describe, it, expect } from 'vitest';
import { determineRouteAction } from '../cr-router.js';
import type { NormalizedEventContext } from '../../../ports/repo-host-events.js';

function ctx(over: Partial<NormalizedEventContext>): NormalizedEventContext {
  return { eventType: 'push', repo: 'o/r', user: 'someone', ...over };
}

describe('determineRouteAction (parity with legacy GitHub router)', () => {
  it('review approved → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request_review', action: 'submitted', state: 'approved' }))).toBe('merge_check');
  });
  it('review changes_requested → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request_review', action: 'submitted', state: 'changes_requested' }))).toBe('existing_task');
  });
  it('review comment → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request_review_comment', action: 'created' }))).toBe('existing_task');
  });
  it('issue_comment created → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'issue_comment', action: 'created' }))).toBe('existing_task');
  });
  it('issue_comment edited → noop', () => {
    expect(determineRouteAction(ctx({ eventType: 'issue_comment', action: 'edited' }))).toBe('noop');
  });
  it('pull_request closed → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request', action: 'closed' }))).toBe('existing_task');
  });
  it('pull_request opened → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request', action: 'opened' }))).toBe('merge_check');
  });
  it('pull_request synchronize → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request', action: 'synchronize' }))).toBe('merge_check');
  });
  it('push → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'push' }))).toBe('merge_check');
  });
  it('workflow_run completed+failure → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'workflow_run', action: 'completed', state: 'failure' }))).toBe('existing_task');
  });
  it('workflow_run completed+success → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'workflow_run', action: 'completed', state: 'success' }))).toBe('merge_check');
  });
  it('check_suite completed+failure → checks_ready', () => {
    expect(determineRouteAction(ctx({ eventType: 'check_suite', action: 'completed', state: 'failure' }))).toBe('checks_ready');
  });
  it('unknown event → noop', () => {
    expect(determineRouteAction(ctx({ eventType: 'ping' }))).toBe('noop');
  });
});
