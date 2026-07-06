/**
 * Host-agnostic change-request routing (spec §3.2). Moved verbatim from
 * github/webhooks.ts: the routing decision and debounced merge/checks handling
 * depend only on NormalizedEventContext + task ids, not on raw payloads or the
 * host vendor. Per-host payload parsing + signature verification stay in each
 * connector (see RepoHostEventSource).
 */

import type { NormalizedEventContext, InternalRouteAction } from '../../ports/repo-host-events.js';
import { logger } from '../../system/logger.js';
// Phase 0: merge orchestrator still lives under github/; injected in Phase 1.
import { checkAndMergeLinkedPRs } from '../github/merge.js';
import { appendGitHubEvent } from '../../tasks/persistence.js';
import { Task } from '../../tasks/task.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';

// ============================================================================
// Merge Check Handling
// ============================================================================

/**
 * Debounce timers for merge checks (per task)
 */
const mergeCheckTimers = new Map<string, NodeJS.Timeout>();
export const MERGE_CHECK_DEBOUNCE_MS = 5000;

/**
 * Handle merge check with debouncing
 *
 * Called for: PR approval, push, CI success
 * Debounces to avoid redundant checks when webhooks arrive in bursts.
 */
export function handleMergeCheckDirect(taskId: string): void {
  // Cancel any pending merge check for this task
  const existingTimer = mergeCheckTimers.get(taskId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    logger.system(`GitHub: Debouncing merge check for task ${taskId}`);
  }

  // Schedule new merge check after debounce delay
  const timer = setTimeout(async () => {
    mergeCheckTimers.delete(taskId);
    logger.system(`GitHub: Running merge check for task ${taskId}`);
    await checkAndMergeLinkedPRs(taskId);
  }, MERGE_CHECK_DEBOUNCE_MS);

  mergeCheckTimers.set(taskId, timer);
}

// ============================================================================
// Checks-Ready Debouncing
// ============================================================================

/**
 * Per-PR debounce timers for check_suite.completed events. A push typically
 * triggers several check suites which complete within seconds of each other;
 * we coalesce them into a single PM ping so the agent inspects checks once.
 *
 * Key format: `${taskId}:${repo}#${prNumber}` — per-PR, not per-task.
 */
const checksReadyTimers = new Map<string, NodeJS.Timeout>();
export const CHECKS_READY_DEBOUNCE_MS = 20_000;

/**
 * Handle check_suite.completed with per-PR debouncing.
 *
 * Resets the timer on every event in the window; on fire, appends one
 * structured GitHub event to knowledge.log and wakes PM with the standard
 * `existingTask` prompt. PM is expected to call `get_pr_checks` to inspect.
 */
export function handleChecksReadyDirect(taskId: string, repo: string, prNumber: number): void {
  const key = `${taskId}:${repo}#${prNumber}`;
  const existingTimer = checksReadyTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    logger.system(`GitHub: Debouncing checks_ready for ${key}`);
  }

  const timer = setTimeout(async () => {
    checksReadyTimers.delete(key);
    logger.system(`GitHub: Firing checks_ready for ${key}`);
    try {
      await appendGitHubEvent(taskId, repo, {
        from: 'ci',
        destination: `PR #${prNumber}`,
        message: `checks updated — call get_pr_checks(${prNumber}) to inspect`,
      });
      const task = await Task.get(taskId);
      await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
    } catch (error) {
      logger.error('checks-ready', `Failed to deliver checks_ready ping for ${key}`, error);
    }
  }, CHECKS_READY_DEBOUNCE_MS);

  checksReadyTimers.set(key, timer);
}

// ============================================================================
// Routing Decision
// ============================================================================

/**
 * Deterministic routing based on event type
 */
export function determineRouteAction(context: NormalizedEventContext): InternalRouteAction {
  const { eventType, action, state } = context;

  switch (eventType) {
    case 'pull_request_review':
      if (state === 'approved') return 'merge_check';
      if (state === 'changes_requested') return 'existing_task';
      if (state === 'commented') return 'existing_task';
      return 'noop';

    case 'pull_request_review_comment':
      return 'existing_task';

    case 'issue_comment':
      if (action !== 'created') return 'noop';
      return 'existing_task';

    case 'pull_request':
      if (action === 'closed') return 'existing_task';
      if (action === 'opened' || action === 'synchronize') return 'merge_check';
      return 'noop';

    case 'push':
      return 'merge_check';

    case 'workflow_run':
      if (action === 'completed') {
        if (state === 'failure') return 'existing_task';
        return 'merge_check';
      }
      return 'noop';

    case 'check_suite':
      if (action !== 'completed') return 'noop';
      // Only wake PM on failure-like conclusions. Success/neutral/skipped
      // are already covered by the pre-existing merge triggers
      // (workflow_run, push, pull_request_review) — no need to duplicate.
      if (
        state === 'failure' ||
        state === 'cancelled' ||
        state === 'timed_out' ||
        state === 'action_required'
      ) {
        return 'checks_ready';
      }
      return 'noop';

    default:
      return 'noop';
  }
}
