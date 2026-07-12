/**
 * GitLab webhook utilities. Per-host payload parsing + token verification;
 * the routing decision is the shared, host-agnostic cr-router. GitLab hooks are
 * translated into the canonical GitHub-semantic NormalizedEventContext vocabulary
 * (design decision 1) so determineRouteAction is reused unchanged.
 */

import crypto from 'crypto';
import { extractTaskIdFromBranch } from '../github/branch-naming.js';
import { findTaskByPRNumber, loadMetadata } from '../../tasks/persistence.js';
import { determineRouteAction } from '../shared/cr-router.js';
import type { NormalizedEventContext, RouteResult, RepoHostEventSource } from '../../ports/repo-host-events.js';

/** Constant-time compare of the X-Gitlab-Token header against the configured secret. */
export function verifyGitLabToken(token: string | undefined, secret: string): boolean {
  if (!token || token.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);

/** GitLab object_kind → canonical NormalizedEventContext (GitHub-semantic vocabulary). */
export function formatGitLabContext(objectKind: string, payload: Obj): NormalizedEventContext {
  const project = asObj(payload.project);
  const repo = (project?.path_with_namespace as string) || 'unknown/unknown';
  const user =
    (asObj(payload.user)?.username as string) ||
    (payload.user_username as string) ||
    'unknown';
  const attrs = asObj(payload.object_attributes) ?? {};
  const mr = asObj(payload.merge_request);

  const base: NormalizedEventContext = { eventType: 'unknown', repo, user };

  if (objectKind === 'merge_request') {
    const action = attrs.action as string | undefined;
    base.prNumber = attrs.iid as number | undefined;
    base.branch = attrs.source_branch as string | undefined;
    switch (action) {
      case 'open':
      case 'reopen':
        return { ...base, eventType: 'pull_request', action: 'opened' };
      case 'update':
        // GitLab's `update` action fires both for new commits pushed to the
        // source branch AND for metadata-only edits (label/title/description/
        // assignee/reviewer/milestone). GitHub's `synchronize` fires ONLY on
        // new commits, so gate on `oldrev` (a commit SHA present only when the
        // source branch actually received new commits) to avoid needless
        // merge checks / card refreshes on trivial metadata edits.
        return attrs.oldrev
          ? { ...base, eventType: 'pull_request', action: 'synchronize' }
          : { ...base, eventType: 'pull_request', action: 'update' };
      case 'close':
        return { ...base, eventType: 'pull_request', action: 'closed', state: 'closed' };
      case 'merge':
        return { ...base, eventType: 'pull_request', action: 'closed', state: 'merged' };
      case 'approved':
        return { ...base, eventType: 'pull_request_review', action: 'submitted', state: 'approved' };
      default:
        // unapproved / unknown MR actions → no routing action (D2 handles
        // changes-requested via unresolved discussions on note events).
        return { ...base, eventType: 'pull_request', action: action ?? '' };
    }
  }

  if (objectKind === 'note') {
    base.prNumber = mr?.iid as number | undefined;
    base.branch = mr?.source_branch as string | undefined;
    base.body = attrs.note as string | undefined;
    base.commentId = attrs.id as number | undefined;
    const noteType = attrs.type as string | undefined; // 'DiffNote' | 'DiscussionNote' | null
    if (noteType === 'DiffNote') {
      return { ...base, eventType: 'pull_request_review_comment', action: 'created' };
    }
    return { ...base, eventType: 'issue_comment', action: 'created' };
  }

  if (objectKind === 'push') {
    const ref = payload.ref as string | undefined;
    return { ...base, eventType: 'push', branch: ref?.replace('refs/heads/', '') };
  }

  if (objectKind === 'pipeline') {
    const status = attrs.status as string | undefined; // success | failed | running | ...
    base.branch = attrs.ref as string | undefined;
    base.prNumber = mr?.iid as number | undefined;
    if (status === 'success') return { ...base, eventType: 'workflow_run', action: 'completed', state: 'success' };
    if (status === 'failed') return { ...base, eventType: 'workflow_run', action: 'completed', state: 'failure' };
    return { ...base, eventType: 'workflow_run', action: status ?? '' }; // running/pending → noop
  }

  return base; // unknown kind → noop
}

/** Branch used for task-id derivation. */
export function extractBranchFromPayload(objectKind: string, payload: Obj): string | undefined {
  const attrs = asObj(payload.object_attributes) ?? {};
  const mr = asObj(payload.merge_request);
  if (objectKind === 'merge_request') return attrs.source_branch as string | undefined;
  if (objectKind === 'note') return mr?.source_branch as string | undefined;
  if (objectKind === 'push') return (payload.ref as string | undefined)?.replace('refs/heads/', '');
  if (objectKind === 'pipeline') return attrs.ref as string | undefined;
  return undefined;
}

/** Structured event for the knowledge log (mirrors the GitHub connector's shape). */
export interface FormattedEvent { from: string; destination: string; message: string; }

export function formatGitLabEvent(context: NormalizedEventContext): FormattedEvent {
  const { eventType, action, user, prNumber, body, state, commentId } = context;
  const prDest = prNumber ? `MR !${prNumber}` : 'MR';
  const cidTag = commentId ? ` [comment_id=${commentId}]` : '';
  switch (eventType) {
    case 'pull_request_review':
      return { from: user, destination: prDest, message: state === 'approved' ? 'approved' : (body ? `reviewed: ${body}` : 'reviewed') };
    case 'pull_request_review_comment':
      return { from: user, destination: prDest, message: body ? `commented on code${cidTag}: ${body}` : `commented on code${cidTag}` };
    case 'issue_comment':
      return { from: user, destination: prDest, message: body ? `${body}${cidTag}` : `(empty)${cidTag}` };
    case 'pull_request':
      if (action === 'closed') return { from: user, destination: prDest, message: state === 'merged' ? 'merged' : 'closed' };
      return { from: user, destination: prDest, message: action ?? '' };
    case 'push':
      return { from: user, destination: `branch:${context.branch || 'unknown'}`, message: 'pushed' };
    case 'workflow_run':
      return { from: 'ci', destination: prNumber ? prDest : `branch:${context.branch || 'unknown'}`, message: `pipeline ${state || action}` };
    default:
      return { from: user, destination: prDest, message: `${eventType}/${action ?? ''}` };
  }
}

function getGitLabBotUsername(): string | null {
  return process.env.GITLAB_BOT_USERNAME || null;
}

export type { RouteResult };

/** Route a GitLab event (mirrors routeGitHubEvent; uses the shared determineRouteAction). */
export async function routeGitLabEvent(objectKind: string, payload: Obj): Promise<RouteResult> {
  const context = formatGitLabContext(objectKind, payload);

  // Loop guard: discard our own comment/review events; exempt machine events.
  const bot = getGitLabBotUsername();
  const isMachineEvent = objectKind === 'push' || objectKind === 'pipeline';
  if (bot && context.user === bot && !isMachineEvent) {
    return { action: 'discard', reason: 'Own bot event' };
  }

  const branch = extractBranchFromPayload(objectKind, payload);
  let taskId = extractTaskIdFromBranch(branch);
  if (!taskId && context.prNumber) {
    taskId = (await findTaskByPRNumber(context.repo, context.prNumber)) ?? undefined;
  }
  if (!taskId) return { action: 'discard', reason: 'Not our branch pattern' };

  const metadata = await loadMetadata(taskId);
  if (!metadata) return { action: 'discard', reason: `Task ${taskId} not found` };

  const routeAction = determineRouteAction(context);
  switch (routeAction) {
    case 'existing_task':
      return { action: 'direct', handler: 'existing_task', taskId };
    case 'merge_check':
      return { action: 'direct', handler: 'merge_check', taskId };
    case 'checks_ready':
      if (!context.prNumber) return { action: 'discard', reason: 'checks_ready without MR' };
      return { action: 'direct', handler: 'checks_ready', taskId, repo: context.repo, prNumber: context.prNumber };
    default:
      return { action: 'discard', reason: `No action needed for ${objectKind}` };
  }
}

/** GitLab's RepoHostEventSource conformer. */
export const gitlabEventSource: RepoHostEventSource = {
  kind: 'gitlab',
  verifySignature(_rawBody, headers, secret) {
    const token = headers['x-gitlab-token'];
    return typeof token === 'string' && verifyGitLabToken(token, secret);
  },
  parseEvent(eventType, payload) {
    return formatGitLabContext(eventType, (payload as Obj) ?? {});
  },
  isSelfEvent(context) {
    return context.user === getGitLabBotUsername();
  },
};
