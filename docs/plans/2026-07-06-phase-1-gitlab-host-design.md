# Phase 1 — GitLab Repo Host (Design)

> Design doc (brainstorming output). The task-by-task implementation plan is a separate artifact produced from this via the writing-plans skill. Source spec: `archie-backend-abstraction-spec.md` §5 Phase 1. Builds on Phase 0 seams (`docs/architecture/backends.md`).

## Required reading (for the implementing agent)

Before writing any code, read these — they define the contract this phase implements:

- `docs/architecture/backends.md` — the backend-abstraction seam (RepoHost / RepoHostEventSource / capabilities / resolver). **The GitLab host must conform to these ports; do not invent a parallel abstraction.**
- `src/ports/repo-host.ts`, `src/ports/repo-host-types.ts`, `src/ports/repo-host-events.ts`, `src/ports/capabilities.ts` — the exact interfaces + canonical (GitHub-shaped) data types GitLab maps into.
- `src/connectors/github/` — the reference implementation to mirror (`client.ts`, `webhooks.ts`, `events.ts`, `repo-clone.ts`).
- `src/connectors/shared/cr-router.ts` — the host-agnostic router GitLab feeds via `NormalizedEventContext`.

## Goal

Add a second repo host (`REPO_HOST=gitlab`) that conforms to the Phase 0 `RepoHost` / `RepoHostEventSource` ports, so a deployment can run against a self-hosted GitLab with zero changes to agents, tools, merge orchestration, or the Slack layer. The existing GitHub path stays default and unchanged (spec P1). GitLab is an anti-corruption adapter: it maps GitLab's REST/webhook surface into the **canonical GitHub-shaped types** already in `src/ports/` (GitHub schema as lingua franca — the A1 decision from Phase 0 hardening).

## Target environment (resolved)

- **Instance:** self-hosted GitLab, **VPN-internal** (reachable only inside the VPN). Implies an internal base URL, likely an internal CA (`NODE_EXTRA_CA_CERTS`), and webhook delivery from inside the VPN.
- **Edition/version:** GitLab EE v18.11.1. EE is the binary; the **licensed tier** (Free/Premium/Ultimate) — which gates approval-rules and security APIs — is detected at boot, not assumed (see Capability probe).
- **Auth (D1):** group (or project) access token on a dedicated bot user, scopes `api, read_repository, write_repository`. Simplest rotation story; self-hosted friendly.
- **Changes-requested (D2):** any unresolved discussion opened by a reviewer counts as "changes requested," behind a capability flag (`reviewStates=false`).

## Module layout

New `src/connectors/gitlab/`, mirroring `connectors/github/`. All GitLab REST calls (via `fetch` against `${GITLAB_BASE_URL}/api/v4`, or the `@gitbeaker/rest` client — decided in the plan) are confined to this directory, exactly as `@octokit` is confined to `github/`. The isolation gate becomes: no GitLab client import outside `src/connectors/gitlab/`.

- `client.ts` — `class GitLabHost implements RepoHost`. REST v4 only (no GraphQL). Maps every response into the canonical `ports/repo-host-types.ts` shapes.
- `webhooks.ts` — `export const gitlabEventSource: RepoHostEventSource`. Parses MR / Note / Push / Pipeline hooks into `NormalizedEventContext`; `verifySignature` = constant-time compare of `X-Gitlab-Token`.
- `events.ts` — `mountGitLabWebhook(app, secret)`: `POST /webhooks/gitlab`, verify token, parse, feed the shared router. Mirrors `github/events.ts`.
- `repo-clone.ts` — `gitlabRepoToUrl(repo)` (`https://<host>/<group>/<project>.git`) and the askpass token provider backing `RepoHost.askpassToken()`.
- `status-map.ts` — pure mapping helpers (`detailed_merge_status` → `MergeableState`, pipeline/job status → `CheckConclusion`, GitLab check-ref parsing). Kept pure so it's unit-testable without the network.

Wiring in `src/system/backends.ts`: add `'gitlab'` to `SUPPORTED_REPO_HOSTS`; `getRepoHost()` returns the `GitLabHost` singleton when `REPO_HOST=gitlab`; `assertBackendConfig()` validates `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET` are present. Boot mounts the GitLab webhook (instead of GitHub) when `REPO_HOST=gitlab`.

## The five key decisions

### 1. Events normalize to the GitHub-canonical vocabulary

`cr-router.determineRouteAction()` switches on GitHub semantic `eventType`/`action`/`state` strings (`pull_request` opened/synchronize/closed, `pull_request_review` approved/changes_requested, `issue_comment`, `push`, `workflow_run`, `check_suite`). GitLab's `parseEvent` **translates** its hooks into those same canonical values so the router is reused untouched. Per spec §3.2:

| Canonical (GitHub) semantic | GitLab hook → normalized to |
|---|---|
| `pull_request` opened/synchronize | Merge Request Hook `action: open/reopen/update` |
| `pull_request` closed/merged | Merge Request Hook `action: close/merge` (carry `state`) |
| `pull_request_review` approved | Merge Request Hook `action: approved` (or Approval events) |
| `pull_request_review` changes_requested | Note Hook on MR from a reviewer with an unresolved discussion (D2) |
| `pull_request_review_comment` | Note Hook on MR diff |
| `issue_comment` | Note Hook on MR (non-diff) |
| `push` | Push Hook |
| `workflow_run`/`check_suite` completed (success/failure) | Pipeline Hook `status: success/failed` |

Doc change: tighten `NormalizedEventContext.eventType`'s comment from "host-native event type string" to "canonical (GitHub-semantic) event type — each host's parser maps into this vocabulary." No type/router code changes.

### 2. Reviews are synthesized (D2)

GitLab has no `changes_requested` review state. `GitLabHost.getPRReviews()` merges two sources into the canonical `PRReview[]`:
- **Approvals API** (`GET /merge_requests/:iid/approvals`) → `state: 'approved'` reviews (one per approver).
- **Unresolved reviewer discussions** (`GET /merge_requests/:iid/discussions`, resolvable + unresolved + not authored by the MR author) → one synthesized `state: 'changes_requested'` review (D2).

`getReviewThreads()` → discussions API (resolvable threads, mapped to `ReviewThread`). `resolveReviewThread()` → `PUT /merge_requests/:iid/discussions/:discussion_id?resolved=true`. `replyToReviewComment()` → `POST …/discussions/:id/notes`. `requestReReview()` → best-effort (reset approvals or re-assign reviewer) or no-op with `capabilities().reReviewRequest=false`.

Capability: `GITLAB_CAPABILITIES.reviewStates=false` (approvals+notes only, not distinct GitHub review states), so any caller that branches on it degrades correctly.

### 3. `merge.ts` relocates to `shared/` (A4)

`merge.ts` is already host-neutral after Phase 0 (it goes through `getRepoHost()` and `RepoHost` methods; it only references the host-agnostic `github` repo-id and `branch_states` in task metadata). So A4 is a **move**, not a dependency-injection rewrite: relocate `connectors/github/merge.ts` → `connectors/shared/merge.ts`, update imports (notably `cr-router.ts`, which then imports from a sibling shared module rather than a vendor connector). Any GitHub-specific helpers it still pulls from `github/` (e.g. branch-state) are evaluated during the move; branch-naming/branch-state are host-agnostic and may move to `shared/` too if needed. Behavior unchanged; existing merge tests must pass.

### 4. `mergeableState` from `detailed_merge_status`

GitLab 18.x exposes `detailed_merge_status` on the MR. Mapping to `MergeableState`:
- `mergeable` → `clean`
- `conflict`, `broken_status` → `dirty`
- `ci_still_running`, `preparing`, `checking`, `unchecked` → `unstable`
- `not_approved`, `discussions_not_resolved`, `draft_status`, `blocked_status`, `not_open`, `need_rebase` → `blocked`
- anything else → `unknown`

`getPRStatus()` composes `PRStatus` from MR `state` (`opened`→`open`, `merged`→`merged`, `closed`→`closed`), `detailed_merge_status`, and approval state.

### 5. Plugin frontmatter unchanged

One `REPO_HOST` per deployment. The existing plugin-frontmatter repo-id field (`github: group/project`) is simply interpreted under the active host — GitLab reads it as `group/project`. No `plugin-loader.ts` change, no mixed-host frontmatter, no `metadata.archie.repo.host` work (that's a later, multi-host concern). Keeps Phase 1 focused.

## Capability probe (spec R2)

At boot, `GitLabHost` calls `GET /license` (Ultimate/Premium expose it; Free/CE returns 403/404). From the result it sets:
- `securityAlerts` = true only when the licensed tier exposes the vulnerability API (Ultimate). Otherwise false → the Phase-0 code-scanning capability gate already returns "not available on this repo host."
- approval-rules-dependent behavior gated similarly.

If the probe fails or is inconclusive, default to the **least-capable** assumption (Free-tier: `securityAlerts=false`) and log the resolved capability matrix at boot (extends the existing `Backends: repoHost=… runtime=…` line). `security.listCodeScanningAlerts`/`getCodeScanningAlert` on GitLab map to the vulnerability API when Ultimate, else throw a clear "not available" (never reached, since the tool gate short-circuits first).

## Auth, clone, and network

- **Token:** `GITLAB_TOKEN` (group/project access token, bot user). `RepoHost.askpassToken()` returns it; `cloneUrl()` returns `https://<host>/<group>/<project>.git`; git auth flows through the existing `scripts/git-askpass.sh` with the token as password (username `oauth2` / the token). This activates the Phase-0-deferred `askpassToken()` wiring (B5).
- **Internal CA:** document `NODE_EXTRA_CA_CERTS` for the internal CA so REST + git over HTTPS trust the internal chain.
- **VPN:** webhooks are delivered from inside the VPN to `POST /webhooks/gitlab`; Slack stays on Socket Mode. Deployment notes go in the setup guide.

## Method mapping (RepoHost → GitLab REST v4)

Implement exactly the surface the tools use. `repo` = `group/project`; URL-encode for the `:id` path param (`encodeURIComponent`). MR number = `iid`.

- `createPullRequest` → `POST /projects/:id/merge_requests`
- `getPRStatus` → `GET …/merge_requests/:iid` (+ approvals) → decision 4
- `getPRDetails` → `GET …/merge_requests/:iid` (+ `/changes` or `/raw_diffs` for `diff`)
- `getPRCardData` → compose from MR + pipeline + approvals
- `listPRs` → `GET …/merge_requests` (map filters)
- `updatePR` / `closePullRequest` → `PUT …/merge_requests/:iid`
- `addPRComment` / `getPRComments` → `POST`/`GET …/merge_requests/:iid/notes`
- `mergePullRequest` → `PUT …/merge_requests/:iid/merge` (merge method mapping; squash flag)
- `pushBranch` → git push via clone (host-agnostic; reuses the existing worktree push)
- `getPRReviews` / `getReviewThreads` / `replyToReviewComment` / `resolveReviewThread` / `requestReReview` → decision 2
- `listPRChecks` → latest pipeline for the MR head SHA + jobs → `PRChecksReport`
- `getCheckRunById` / `getWorkflowRunById` → job / pipeline by id → `CheckRunReport` / `WorkflowRunReport`
- `fetchJobLogTail` (used via checks) → `GET /projects/:id/jobs/:job_id/trace`, reuse the existing `Failures:`-marker tail truncation
- `listAccessibleRepos` → `GET /projects?membership=true` (map to `{ github: 'group/project', default_branch, description }`)
- `resolveRepo` → `GET /projects/:id` → `{ default_branch }`
- `listCodeScanningAlerts` / `getCodeScanningAlert` → vulnerability API when Ultimate; else capability-gated off
- optional (flagged, not default): native "merge when pipeline succeeds" when `nativeAutoMerge` is on; **default keeps Archie's orchestrator** for behavior parity.

## Testing

- **Unit (mirror `github/__tests__`):** `status-map` (`detailed_merge_status` → `MergeableState`, pipeline/job → `CheckConclusion`), webhook `parseEvent` → `NormalizedEventContext` for each hook type, `determineRouteAction` parity through the GitLab normalization, log-tail truncation, review synthesis (D2) from approvals + unresolved discussions. All network calls mocked.
- **Regression:** the full default-config (`REPO_HOST=github`) suite stays green and unmodified.
- **E2E (manual gate — cannot run from here):** against the real VPN GitLab test project: full flow (investigate → approve → edit → MR → merge), review-comment wake-up, failed-pipeline log tail, conflict path (dirty → PM notified → rebase → merge). Documented as a checklist in the setup guide; the local `archie-e2e` harness covers the GitHub matrix.

## Docs

- `docs/guides/gitlab-setup.md` — bot user + group token scopes, webhook config (incl. VPN-internal URL and `X-Gitlab-Token`), protected-branch/approval recommendations, `NODE_EXTRA_CA_CERTS`, and the E2E checklist.
- Update `docs/architecture/backends.md`: flip GitLab from "Phase 1 (not available)" to a real second host; document `GITLAB_CAPABILITIES`, the license probe, and that `merge.ts` moved to `shared/`.

## Out of scope (Phase 1)

- opencode runtime (Phase 2); PR→CR / github→repo neutral renaming (Phase 4); mixed-host plugin frontmatter; horizontal scaling; triage re-enablement; Slack-layer changes.

## Acceptance

- `REPO_HOST=gitlab` boots, validates env, logs the resolved capability matrix, mounts `/webhooks/gitlab`.
- New unit tests (status mapping, webhook parsing → router, review synthesis) pass; default-config regression suite green and unmodified.
- GitLab REST client imports confined to `src/connectors/gitlab/` (isolation grep clean, mirroring the `@octokit` gate).
- Manual E2E checklist passes against the VPN instance (owner-run).
