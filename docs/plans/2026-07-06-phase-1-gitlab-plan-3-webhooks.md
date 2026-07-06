# Phase 1 · GitLab Host — Plan 3: Webhooks, Event Routing & Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-06-phase-1-gitlab-host-design.md` — Phase 1 design (esp. decision 1: events normalize to the *canonical GitHub-semantic* vocabulary; decision 3: `merge.ts` relocates to `shared/`).
> - `docs/architecture/backends.md` — the seam (RepoHostEventSource + shared cr-router).
> - `src/ports/repo-host-events.ts` — `NormalizedEventContext`, `InternalRouteAction`, `RouteResult`, `RepoHostEventSource`.
> - `src/connectors/shared/cr-router.ts` — `determineRouteAction`, `handleMergeCheckDirect`, `handleChecksReadyDirect` (all host-agnostic; reused as-is).
> - `src/connectors/github/webhooks.ts` + `src/connectors/github/events.ts` — the reference implementations this mirrors.

**Goal:** Make `REPO_HOST=gitlab` handle inbound webhooks end-to-end — verify `X-Gitlab-Token`, parse MR/Note/Push/Pipeline hooks into the canonical `NormalizedEventContext` vocabulary, route through the shared `cr-router`, and wake the PM / run merge checks / refresh CR cards — plus close the two Plan-1 carry-forwards: relocate `merge.ts` to `shared/` and make `get_check_run` host-aware. GitHub's path stays byte-for-byte unchanged.

**Architecture:** Per-host payload parsing + signature verification live in `src/connectors/gitlab/` (mirroring `github/`); the routing decision and debounce handlers are the already-shared `cr-router`. GitLab's `parseEvent` translates each GitLab hook into the canonical GitHub-semantic `eventType`/`action`/`state` (design decision 1) so `determineRouteAction` is reused untouched. `merge.ts` moves to `connectors/shared/` (it is already host-neutral via `getRepoHost()`).

**Tech Stack:** Node ≥20 (ESM, `.js` specifiers), TypeScript, Vitest ^4, Express (existing), `crypto.timingSafeEqual` for token compare.

## Global Constraints

- **Additive / zero behavior change (P1).** GitHub webhook handling, routing, and merge behavior are unchanged. Full suite (`npm test`) passes unmodified after every task; existing tests not edited. Default `REPO_HOST=github`.
- **Canonical vocabulary.** GitLab `parseEvent` emits the *GitHub-semantic* `eventType`/`action`/`state` that `determineRouteAction` switches on (`pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `push`, `workflow_run`) — never GitLab-native strings like `'Merge Request Hook'`.
- **Vendor isolation.** GitLab payload/HTTP specifics stay in `src/connectors/gitlab/`; the router and dispatch stay host-neutral.
- **Signature safety.** `X-Gitlab-Token` compared with `crypto.timingSafeEqual` over equal-length buffers (guard length first).
- **Self-event guard.** Filter the bot's own comment/review events (loop guard); exempt machine events (push, pipeline) as GitHub does.
- **Logging.** Never `console.*`; use `logger` (`logger.system`, `logger.warn('gitlab', ...)`, `logger.error('gitlab', ...)`).
- **Commits.** Atomic, one logical change per task; commit at task end (authorized; do not push).

## Decisions baked in

- **`merge.ts` relocation is a pure move** (T1): its imports are depth-neutral (`connectors/shared/` and `connectors/github/` are the same depth), so only `cr-router.ts`'s import path changes. It is the sole importer.
- **GitLab pipeline failures map to `workflow_run` completed+failure** (→ `existing_task`), not `check_suite`→`checks_ready`. Simpler and behavior-adequate; the debounced checks-ready path stays GitHub-only for now (noted follow-up).
- **`gitlab/events.ts` mirrors the `github/events.ts` dispatch** (existing-task wake with comment dedup + CR-card refresh) rather than refactoring a shared dispatch out of the working GitHub path. Consolidating both into `connectors/shared/webhook-dispatch.ts` is a **noted follow-up** (keeps P1 risk low now).
- **Pure branch helpers are reused from `github/`.** `extractTaskIdFromBranch` (`branch-naming.ts`) and `findBranchStateByPR` (`branch-state.ts`) are host-agnostic; GitLab imports them directly. Relocating them to `shared/` is a Phase-4 concern.
- **`appendGitHubEvent`** (in `tasks/persistence.ts`) is host-neutral in behavior (writes `{from,destination,message}` to the knowledge log); GitLab reuses it. The legacy name is a Phase-4 rename.

## File Structure

New files:
- `src/connectors/shared/merge.ts` — moved from `github/merge.ts` (T1).
- `src/connectors/gitlab/webhooks.ts` — `formatGitLabContext`, `verifyGitLabToken`, `extractBranchFromPayload`, `formatGitLabEvent`, `routeGitLabEvent`, `gitlabEventSource` (T2).
- `src/connectors/gitlab/events.ts` — `mountGitLabWebhook` + dispatch (T3).
- `src/connectors/gitlab/__tests__/webhooks.test.ts` (T2).

Modified files:
- `src/connectors/shared/cr-router.ts` — import `merge.js` from `./` (T1).
- `src/connectors/github/merge.ts` — deleted (moved) (T1).
- `src/ports/repo-host-events.ts` — tighten the `eventType` doc comment (T3).
- `src/index.ts` — `gitlabWebhookSecret` config + mount GitLab webhook when `REPO_HOST=gitlab` (T3).
- `src/agents/tools.ts` — host-aware `get_check_run` (T4).

## Task order

T1 (relocate merge.ts) → T2 (gitlab webhooks parse/verify/route) → T3 (events mount + dispatch + wiring) → T4 (host-aware get_check_run).

---

## Task 1: Relocate `merge.ts` to `connectors/shared/` (closes A4)

**Files:**
- Create: `src/connectors/shared/merge.ts` (moved content)
- Delete: `src/connectors/github/merge.ts`
- Modify: `src/connectors/shared/cr-router.ts` (import path)

**Interfaces:**
- Produces: `checkAndMergeLinkedPRs`, `triggerMergeCheck`, `MergeCheckResult` from `connectors/shared/merge.js` (same exports, new location).

- [ ] **Step 1: Check for a merge test to move alongside.**

Run: `ls src/connectors/github/__tests__/ 2>/dev/null | grep -i merge || echo "no merge test"`
If a `merge*.test.ts` exists, it moves too (Step 2) and its import of `../merge.js` stays valid (same relative depth under `shared/__tests__/`). If none, skip its move.

- [ ] **Step 2: Move the file with git (preserves history).**

```bash
git mv src/connectors/github/merge.ts src/connectors/shared/merge.ts
# if a merge test exists:
# git mv src/connectors/github/__tests__/merge.test.ts src/connectors/shared/__tests__/merge.test.ts
```

`merge.ts`'s imports (`../../tasks/...`, `../../system/...`, `../../agents/...`, `../../ports/...`) are unchanged — `connectors/shared/` is the same depth as `connectors/github/`.

- [ ] **Step 3: Repoint the cr-router import.** In `src/connectors/shared/cr-router.ts`, change:

```ts
// Phase 0: merge orchestrator still lives under github/; injected in Phase 1.
import { checkAndMergeLinkedPRs } from '../github/merge.js';
```
to:
```ts
import { checkAndMergeLinkedPRs } from './merge.js';
```

- [ ] **Step 4: Find any other importer (should be none besides cr-router).**

Run: `grep -rn "github/merge.js\|connectors/github/merge" src --include="*.ts"`
Expected: empty. If anything remains, repoint it to `../shared/merge.js` (or `./merge.js` as appropriate).

- [ ] **Step 5: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS, unchanged count. Behavior identical — pure relocation.

- [ ] **Step 6: Commit.**

```bash
git add -A src/connectors/shared/merge.ts src/connectors/github/merge.ts src/connectors/shared/cr-router.ts
git commit -m "refactor(merge): relocate host-neutral merge orchestrator to connectors/shared (A4)"
```

---

## Task 2: `gitlab/webhooks.ts` — parse, verify, route, event source

**Files:**
- Create: `src/connectors/gitlab/webhooks.ts`
- Create: `src/connectors/gitlab/__tests__/webhooks.test.ts`

**Interfaces:**
- Consumes: `NormalizedEventContext`, `RouteResult`, `RepoHostEventSource` (`ports/repo-host-events.js`); `determineRouteAction` (`shared/cr-router.js`); `extractTaskIdFromBranch` (`github/branch-naming.js`); `findTaskByPRNumber`, `loadMetadata` (`tasks/persistence.js`).
- Produces: `verifyGitLabToken`, `formatGitLabContext`, `extractBranchFromPayload`, `formatGitLabEvent`, `routeGitLabEvent`, `gitlabEventSource`. Consumed by T3.

> GitLab sends `object_kind` in the JSON body (and an `X-Gitlab-Event` header like "Merge Request Hook"). Parse from `object_kind`. Canonical mapping (design decision 1 / spec §3.2): MR open/reopen→`pull_request`/`opened`; MR update→`pull_request`/`synchronize`; MR close→`pull_request`/`closed` (state `closed`); MR merge→`pull_request`/`closed` (state `merged`); MR approved→`pull_request_review`/`submitted` (state `approved`); note on diff→`pull_request_review_comment`; note on MR→`issue_comment`/`created`; push→`push`; pipeline→`workflow_run`/`completed` (state `success`|`failure`).

- [ ] **Step 1: Write the failing tests.** Create `src/connectors/gitlab/__tests__/webhooks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/gitlab/__tests__/webhooks.test.ts`
Expected: FAIL — cannot find module `../webhooks.js`.

- [ ] **Step 3: Implement `src/connectors/gitlab/webhooks.ts`.**

```ts
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
  const user = (asObj(payload.user)?.username as string) || 'unknown';
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
        return { ...base, eventType: 'pull_request', action: 'synchronize' };
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
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/webhooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + commit.**

```bash
npm test
git add src/connectors/gitlab/webhooks.ts src/connectors/gitlab/__tests__/webhooks.test.ts
git commit -m "feat(gitlab): webhook parse/verify/route into canonical vocabulary + event source"
```

---

## Task 3: `gitlab/events.ts` — HTTP mount + dispatch + wiring

**Files:**
- Create: `src/connectors/gitlab/events.ts`
- Modify: `src/index.ts` (config + conditional mount)
- Modify: `src/ports/repo-host-events.ts` (doc comment)

**Interfaces:**
- Consumes: `routeGitLabEvent`, `formatGitLabContext`, `formatGitLabEvent`, `verifyGitLabToken`, `extractBranchFromPayload` (T2); `handleMergeCheckDirect`, `handleChecksReadyDirect` (`shared/cr-router.js`); `Task`, `appendGitHubEvent`, `findTaskByBranch`, `findTaskByPRNumber` (`tasks/persistence.js`); `findBranchStateByPR` (`github/branch-state.js`); `AGENT_PROMPTS`.
- Produces: `mountGitLabWebhook(app, secret)`.

> Mirrors `github/events.ts`: verify token → parse → route → dispatch (`merge_check`/`existing_task`/`checks_ready`) + debounced CR-card refresh. The debounce handlers are the shared ones. Duplication with `github/events.ts` is deliberate for P1 safety; consolidation into `connectors/shared/webhook-dispatch.ts` is a noted follow-up.

- [ ] **Step 1: Implement `src/connectors/gitlab/events.ts`.**

```ts
/**
 * GitLab webhook HTTP handler. Verifies X-Gitlab-Token, parses the payload into
 * the canonical NormalizedEventContext, routes via the shared cr-router, and
 * dispatches to the merge-check / existing-task / checks-ready handlers, plus a
 * debounced CR-card refresh. Mirrors github/events.ts (consolidation TODO).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import type { Application, Request, Response } from 'express';
import {
  routeGitLabEvent, formatGitLabContext, formatGitLabEvent,
  verifyGitLabToken, extractBranchFromPayload,
} from './webhooks.js';
import { handleMergeCheckDirect, handleChecksReadyDirect } from '../shared/cr-router.js';
import type { NormalizedEventContext } from '../../ports/repo-host-events.js';
import { Task } from '../../tasks/task.js';
import { appendGitHubEvent, findTaskByBranch, findTaskByPRNumber } from '../../tasks/persistence.js';
import { findBranchStateByPR } from '../github/branch-state.js';
import { extractTaskIdFromBranch } from '../github/branch-naming.js';
import { AGENT_PROMPTS } from '../../agents/prompts.js';
import { logger } from '../../system/logger.js';
import { getIsShuttingDown } from '../../system/shutdown.js';

export function mountGitLabWebhook(app: Application, secret: string): void {
  logger.plain('GitLab webhook: POST /webhooks/gitlab');
  app.post('/webhooks/gitlab', require('express').raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    if (getIsShuttingDown()) { res.status(503).json({ error: 'Server is shutting down' }); return; }

    const token = req.headers['x-gitlab-token'] as string | undefined;
    if (!verifyGitLabToken(token, secret)) {
      logger.warn('Server', 'Invalid GitLab webhook token');
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    res.status(200).json({ received: true });

    try {
      const payload = JSON.parse(req.body.toString()) as Record<string, unknown>;
      const objectKind = (payload.object_kind as string) || (req.headers['x-gitlab-event'] as string) || 'unknown';
      await handleGitLabWebhook(objectKind, payload);
    } catch (error) {
      logger.error('Server', 'Error processing GitLab webhook', error);
    }
  });
}

async function handleGitLabWebhook(objectKind: string, payload: Record<string, unknown>): Promise<void> {
  const context = formatGitLabContext(objectKind, payload);
  logger.system(
    `GitLab webhook: ${context.eventType}/${context.action ?? ''} repo=${context.repo}` +
    (context.prNumber ? ` mr=!${context.prNumber}` : '') +
    (context.branch ? ` branch=${context.branch}` : '') +
    ` user=${context.user}` + (context.state ? ` state=${context.state}` : '')
  );

  await maybeRefreshCrCards(objectKind, payload, context);

  const route = await routeGitLabEvent(objectKind, payload);
  if (route.action === 'discard') { logger.system(`GitLab: ${route.reason}`); return; }
  if (route.action === 'direct') {
    if (route.handler === 'merge_check') handleMergeCheckDirect(route.taskId);
    else if (route.handler === 'existing_task') await handleExistingTaskDirect(route.taskId, context);
    else if (route.handler === 'checks_ready') handleChecksReadyDirect(route.taskId, route.repo, route.prNumber);
  }
}

const cardRefreshTimers = new Map<string, NodeJS.Timeout>();
const CARD_REFRESH_DEBOUNCE_MS = 2500;

async function resolveCardTask(objectKind: string, payload: Record<string, unknown>, context: NormalizedEventContext): Promise<Task | null> {
  const branch = extractBranchFromPayload(objectKind, payload);
  let taskId = extractTaskIdFromBranch(branch);
  if (!taskId && branch) taskId = (await findTaskByBranch(context.repo, branch)) ?? undefined;
  if (!taskId && context.prNumber) taskId = (await findTaskByPRNumber(context.repo, context.prNumber)) ?? undefined;
  if (!taskId) return null;
  try { return await Task.get(taskId); } catch { return null; }
}

async function maybeRefreshCrCards(objectKind: string, payload: Record<string, unknown>, context: NormalizedEventContext): Promise<void> {
  const isClosed = context.eventType === 'pull_request' && context.action === 'closed';
  const relevant = isClosed || objectKind === 'pipeline' || objectKind === 'push' || objectKind === 'note' ||
    (context.eventType === 'pull_request' && (context.action === 'opened' || context.action === 'synchronize'));
  if (!relevant) return;

  if (isClosed) {
    const task = await resolveCardTask(objectKind, payload, context);
    if (task && context.prNumber) {
      try { await task.refreshPrCardInPlace(context.repo, context.prNumber); }
      catch (error) { logger.warn('Server', 'CR card refresh failed on MR close', error); }
    }
    return;
  }

  const branch = extractBranchFromPayload(objectKind, payload);
  const key = `${context.repo}:${branch ?? context.prNumber ?? '?'}`;
  const existing = cardRefreshTimers.get(key);
  if (existing) clearTimeout(existing);
  cardRefreshTimers.set(key, setTimeout(() => {
    cardRefreshTimers.delete(key);
    void (async () => {
      try { const task = await resolveCardTask(objectKind, payload, context); if (task) await task.refreshAllPrCards(); }
      catch (error) { logger.warn('Server', `CR card CI refresh failed (${key})`, error); }
    })();
  }, CARD_REFRESH_DEBOUNCE_MS));
}

async function handleExistingTaskDirect(taskId: string, context: NormalizedEventContext): Promise<void> {
  const task = await Task.get(taskId);

  // Comment dedup for note events (guard against webhook redelivery), mirroring
  // the GitHub connector's last_processed_comment_id bookkeeping.
  if (context.eventType === 'issue_comment' && context.prNumber && context.commentId) {
    let lastProcessedId = 0;
    const matches: Array<{ state: { last_processed_comment_id?: number } }> = [];
    for (const attachments of Object.values(task.metadata.repositories)) {
      if (!Array.isArray(attachments)) continue;
      for (const attached of attachments) {
        if (attached.github !== context.repo) continue;
        const branchMatch = findBranchStateByPR(attached, context.prNumber);
        if (!branchMatch) continue;
        matches.push(branchMatch);
        const seen = branchMatch.state.last_processed_comment_id ?? 0;
        if (seen > lastProcessedId) lastProcessedId = seen;
      }
    }
    if (context.commentId <= lastProcessedId) {
      logger.system(`GitLab: Skipping already-processed note ${context.commentId} on MR !${context.prNumber}`);
      return;
    }
    for (const m of matches) m.state.last_processed_comment_id = context.commentId;
    task.debouncedSave();
  }

  await appendGitHubEvent(taskId, context.repo, formatGitLabEvent(context));
  await task.sendMessage(AGENT_PROMPTS.existingTask, 'pm-agent');
}
```

- [ ] **Step 2: Tighten the `NormalizedEventContext.eventType` doc comment** in `src/ports/repo-host-events.ts`:

Change:
```ts
  /** host-native event type string, e.g. 'pull_request', 'Merge Request Hook'. */
  eventType: string;
```
to:
```ts
  /** canonical (GitHub-semantic) event type — each host's parser maps its native
   *  events into this vocabulary ('pull_request', 'pull_request_review',
   *  'pull_request_review_comment', 'issue_comment', 'push', 'workflow_run', …). */
  eventType: string;
```

- [ ] **Step 3: Wire the mount in `src/index.ts`.**

In `loadConfig()`, after `githubWebhookSecret`:
```ts
const gitlabWebhookSecret = process.env.GITLAB_WEBHOOK_SECRET;
```
Add `gitlabWebhookSecret` to the returned config object (and to the `AppConfig` type where `githubWebhookSecret` is declared — find it and add `gitlabWebhookSecret?: string`).

Add the import near the GitHub one:
```ts
import { mountGitLabWebhook } from './connectors/gitlab/events.js';
```

At the mount site (replace the unconditional `// Mount GitHub webhook (if configured)` block ~line 236-238) with a host-branched mount:
```ts
// Mount the active repo host's webhook.
if (resolveRepoHostKind() === 'gitlab') {
  if (config.gitlabWebhookSecret) {
    mountGitLabWebhook(app, config.gitlabWebhookSecret);
  } else {
    logger.warn('Server', 'REPO_HOST=gitlab but GITLAB_WEBHOOK_SECRET is unset — GitLab webhook not mounted');
  }
} else if (config.githubWebhookSecret) {
  mountGitHubWebhook(app, config.githubWebhookSecret);
}
```
(Keep the existing GitHub branch behavior identical when `REPO_HOST=github`.)

- [ ] **Step 4: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS, GitHub path unchanged (default config still mounts the GitHub webhook).

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/events.ts src/index.ts src/ports/repo-host-events.ts
git commit -m "feat(gitlab): mount webhook endpoint + dispatch; canonical eventType doc"
```

---

## Task 4: Host-aware `get_check_run`

**Files:**
- Modify: `src/agents/tools.ts` (`createGetCheckRunTool`; import `parseGitLabCheckRef`)

**Interfaces:**
- Consumes: `parseCheckRef` (`connectors/github/client.js`), `parseGitLabCheckRef` (`connectors/gitlab/status-map.js`), `getRepoHost().kind`.
- Produces: `get_check_run` dispatches GitLab job/pipeline refs correctly (closes the Plan-1 carry-forward; makes `getWorkflowRunById` reachable on GitLab).

> `parseCheckRef` (GitHub) throws on unparseable and returns `{kind:'check_run'|'workflow_run', id, owner?, repo?}`. `parseGitLabCheckRef` (GitLab) returns `null` on unparseable and `{kind:'job'|'pipeline', id}`. Normalize both to `{kind:'check_run'|'workflow_run', id, owner?, repo?}` so the existing dispatch below is unchanged.

- [ ] **Step 1: Write the failing test.** Append to `src/agents/__tests__/pr-tools.test.ts` a block that drives `get_check_run` against a GitLab host. Reuse the file's `getRepoTool`/`makeAgent`/`makeTask` and the `getGitHubClient` mock seam:

```ts
describe('get_check_run — host-aware ref parsing', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('routes a GitLab pipeline URL to getWorkflowRunById', async () => {
    const host = {
      kind: 'gitlab' as const,
      getWorkflowRunById: vi.fn().mockResolvedValue({
        id: 99, name: 'pipeline #99', status: 'failed', conclusion: 'failure',
        headSha: 'abc', headBranch: 'feat/x', url: 'u', jobs: [],
      }),
      getCheckRunById: vi.fn(),
    };
    vi.mocked(getGitHubClient).mockReturnValue(host as any);

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    const result = await tool({ ref: 'https://gl.example/org/backend/-/pipelines/99' }, {});

    expect(host.getWorkflowRunById).toHaveBeenCalledWith('org/backend', 99);
    expect(host.getCheckRunById).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('pipeline #99');
  });

  it('routes a GitLab job id to getCheckRunById', async () => {
    const host = {
      kind: 'gitlab' as const,
      getWorkflowRunById: vi.fn(),
      getCheckRunById: vi.fn().mockResolvedValue({
        id: 42, name: 'rspec', app: 'test', status: 'completed', conclusion: 'failure',
        url: null, headSha: null, startedAt: null, completedAt: null,
      }),
    };
    vi.mocked(getGitHubClient).mockReturnValue(host as any);

    const tool = getRepoTool(makeAgent(), makeTask(), 'get_check_run');
    await tool({ ref: '42' }, {});
    expect(host.getCheckRunById).toHaveBeenCalledWith('org/backend', 42);
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/agents/__tests__/pr-tools.test.ts -t "host-aware"`
Expected: FAIL — a bare `'42'` currently parses via `parseCheckRef` as `check_run` (works), but the GitLab pipeline URL fails `parseCheckRef` (throws "Could not extract…"). At least the pipeline-URL case fails.

- [ ] **Step 3: Add the import** at the top of `src/agents/tools.ts` (near the `parseCheckRef` import at line 21):

```ts
import { parseGitLabCheckRef } from '../connectors/gitlab/status-map.js';
```

- [ ] **Step 4: Make the parse host-aware** inside `createGetCheckRunTool`. Replace the `let parsed; try { parsed = parseCheckRef(args.ref); } catch (e) { ... }` block (tools.ts ~927-932) with:

```ts
let parsed: { kind: 'check_run' | 'workflow_run'; id: number; owner?: string; repo?: string };
if (client.kind === 'gitlab') {
  const gl = parseGitLabCheckRef(args.ref);
  if (!gl) return err(`Could not parse a GitLab job/pipeline reference from "${args.ref}".`);
  parsed = { kind: gl.kind === 'pipeline' ? 'workflow_run' : 'check_run', id: gl.id };
} else {
  try {
    parsed = parseCheckRef(args.ref);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
```

The downstream dispatch (`if (parsed.kind === 'workflow_run') … else …`) and the `parsed.owner && parsed.repo` scoping check are unchanged — GitLab refs have no `owner`/`repo`, so the scoping block is skipped.

- [ ] **Step 5: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/agents/__tests__/pr-tools.test.ts && npm test`
Expected: PASS (baseline + 2 new; existing GitHub `get_check_run` tests unchanged).

- [ ] **Step 6: Commit.**

```bash
git add src/agents/tools.ts src/agents/__tests__/pr-tools.test.ts
git commit -m "feat(tools): host-aware get_check_run — parse GitLab job/pipeline refs"
```

---

## Self-Review

- **Spec coverage:** merge.ts relocation / A4 (T1); GitLab webhook parse→canonical vocabulary + verify + route + event source (T2); HTTP mount + dispatch (existing-task wake, comment dedup, CR-card refresh) + index wiring + eventType doc (T3); host-aware `get_check_run` closing the Plan-1 carry-forward (T4).
- **Placeholder scan:** none. The `github/events.ts`-mirroring dispatch in T3 is complete code, with the consolidation into `shared/webhook-dispatch.ts` explicitly logged as a follow-up (not a placeholder).
- **Type consistency:** `formatGitLabContext` returns `NormalizedEventContext`; `routeGitLabEvent` returns `RouteResult` (with the `repo`/`prNumber` fields for `checks_ready`); `get_check_run` normalizes both parsers to `{kind:'check_run'|'workflow_run', id}`.
- **P1:** GitHub webhook/routing/merge behavior untouched — T1 is a pure move (cr-router import only), T3 branches the mount on host kind (GitHub branch identical), T4 branches on `client.kind` (GitHub path unchanged).
- **Canonical vocabulary:** GitLab `parseEvent` never emits GitLab-native event strings; `determineRouteAction` is reused unchanged and covered by parity assertions in the webhook tests.
- **Follow-ups recorded:** consolidate github/gitlab `events.ts` dispatch into `shared/webhook-dispatch.ts`; relocate `branch-naming.ts`/`branch-state.ts` to `shared/` (Phase 4); GitLab pipeline-failure → `checks_ready` debounced path (currently maps to `existing_task`).
