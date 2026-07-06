## ADDED Requirements

### Requirement: Per-repo autoMerge flag, default off

Repo-agent frontmatter SHALL accept an optional `autoMerge` boolean on each repo entry (`metadata.archie.repos[].autoMerge`; the legacy singular `metadata.archie.repo.autoMerge` SHALL be auto-migrated with the rest of the singular shape). The flag SHALL default to off: only the boolean literal `true` enables it, and absent or non-boolean values SHALL resolve to false. The resolved value SHALL be threaded through the plugin-loader and registry copies so it is available on every `RepoEntry`; dynamic (PM-spawned) agents SHALL always resolve to false.

#### Scenario: Flag absent everywhere (the shipped state)
- **WHEN** no agent frontmatter anywhere sets `autoMerge`
- **THEN** every repo resolves to autoMerge off, including Archie's own repo, and no repo auto-merges

#### Scenario: Flag parsed from the plural shape
- **WHEN** an agent declares `metadata.archie.repos: [{github: X, autoMerge: true}]`
- **THEN** the registry's `RepoEntry` for X carries `autoMerge: true`

#### Scenario: Non-boolean value fails safe
- **WHEN** frontmatter sets `autoMerge` to a non-boolean value (e.g. the string `"true"`)
- **THEN** the entry resolves to autoMerge off

#### Scenario: Legacy singular shape migrates
- **WHEN** an agent declares the legacy `metadata.archie.repo: {github: X, autoMerge: true}`
- **THEN** the synthesized plural form preserves `autoMerge: true` for X

### Requirement: Repo-level policy resolution requires unanimous opt-in

The system SHALL resolve a repo's merge policy at merge time via the registered agents that declare it: a repo is auto-mergeable only when at least one registered agent declares it AND every declaring agent's entries for it set `autoMerge: true`. A repo declared by no registered agent SHALL never be auto-mergeable. Conflicting declarations SHALL resolve to off and be logged as a warning.

#### Scenario: Conflicting flags resolve to off
- **WHEN** two agents declare the same repo, one with `autoMerge: true` and one without
- **THEN** the repo resolves to autoMerge off and a warning is logged

#### Scenario: Undeclared repo is never auto-merged
- **WHEN** a PR belongs to a repo no registered agent declares (e.g. attached only via a dynamic agent)
- **THEN** the repo resolves to autoMerge off

### Requirement: Orchestrator holds non-auto PRs and notifies once per ready state

When a merge-triggering webhook arrives, the merge orchestrator SHALL evaluate policy per PR. A ready PR (open, approved, and mergeable per GitHub) in a non-auto repo SHALL NOT be merged; instead the PM SHALL be prompted to post exactly one Slack-thread notification that the PR is ready and can be merged on request. A ready PR whose merge-approval request is currently pending SHALL NOT produce the notification — the user already holds an actionable prompt for it. Once-ness SHALL be enforced by a persisted per-branch marker that is set when the notification fires and cleared when a merge check observes the PR no longer ready, so repeated webhooks for the same ready state never re-notify, restarts do not re-notify, and a PR that becomes un-ready and then ready again notifies again.

#### Scenario: Non-auto ready PR is held and notified once (AC1)
- **WHEN** an approval webhook arrives for a mergeable PR in a repo without `autoMerge: true`
- **THEN** the system does not merge the PR and the PM posts exactly one ready notification to the Slack thread

#### Scenario: Webhook burst for the same ready state does not re-notify (AC1)
- **WHEN** multiple merge-triggering webhooks (approval, synchronize, push, workflow_run) arrive for the same PR while it stays ready
- **THEN** no additional ready notification is produced

#### Scenario: Re-ready after new commits notifies again
- **WHEN** a previously-notified PR becomes not-ready (e.g. new commits, CI pending) and later becomes ready again
- **THEN** the ready notification is produced once more

#### Scenario: Pending merge approval suppresses the ready nudge
- **WHEN** a merge check observes a ready non-auto PR whose merge-approval request is currently pending
- **THEN** no ready notification is produced for that PR

#### Scenario: Auto repo merges as today (AC2)
- **WHEN** an approval webhook arrives for a mergeable PR in a repo whose policy resolves to `autoMerge: true`
- **THEN** the system squash-merges the PR exactly as before this change

#### Scenario: Mixed-policy task is evaluated per PR
- **WHEN** one task has a ready PR in an auto repo and a ready PR in a non-auto repo
- **THEN** the auto PR merges and the non-auto PR is held with a ready notification

### Requirement: merge_pull_request gates on policy

The `merge_pull_request` tool SHALL check the repo's merge policy before acting. In an auto repo it SHALL merge directly with no extra approval prompt (current behavior). In a non-auto repo it SHALL NOT merge; when the PR is open and mergeable per GitHub it SHALL post a merge-approval request (approval type `merge`) mirroring the edit-mode flow — interactive approve/deny message, duplicate-request suppression, status suspension, and a deferred task pause — and SHALL persist the requested PR (`github`, `pr_number`, requesting agent) in task metadata so resolution survives restarts. Duplicate suppression SHALL be gated on task-level quiescence: while any agent process in the task holds the parked pause of an unresolved request, a repeat call SHALL report the request as already pending and post nothing. A pending request left unresolved after the task has quiesced and been reactivated (no agent in the task holds a parked pause) SHALL be superseded by a later call: the persisted request is rewritten for the newly requested PR and a fresh prompt is posted, so a stale request can never permanently block merging. The tool's readiness condition SHALL NOT require GitHub review approvals, and SHALL use the same GitHub-mergeability condition as the orchestrator (clean, or blocked with `mergeable=true`).

#### Scenario: Non-auto repo requests approval instead of merging (AC3)
- **WHEN** an agent calls `merge_pull_request` for an open, mergeable PR in a non-auto repo
- **THEN** no merge occurs, an `approval:requested` event of type `merge` is emitted, the pending request is persisted, and the task pauses

#### Scenario: Auto repo merges directly (AC6)
- **WHEN** an agent calls `merge_pull_request` in an `autoMerge: true` repo in edit mode and GitHub reports the PR mergeable
- **THEN** the tool merges immediately with no approval prompt

#### Scenario: Duplicate request while the pause is parked is suppressed
- **WHEN** `merge_pull_request` is called again while any agent process in the task still holds the parked pause of an unresolved merge request — whether in the same agent turn that posted it or from a concurrently running second agent in a multi-repo task
- **THEN** no second prompt is posted, the pending request is not superseded, and the tool reports the request is already pending

#### Scenario: Stale pending request is superseded after quiescence
- **WHEN** the task quiesced and was reactivated without its pending merge request being resolved (no agent in the task holds a parked pause) and `merge_pull_request` is called again
- **THEN** the persisted request is rewritten for the requested PR and a fresh approval prompt is posted

#### Scenario: Zero review approvals do not block the request (AC5)
- **WHEN** the PR has zero GitHub review approvals but GitHub reports it mergeable
- **THEN** the approval request is posted normally — Archie imposes no approval floor

#### Scenario: Not-mergeable PR reports status instead of prompting
- **WHEN** `merge_pull_request` is called in a non-auto repo and GitHub reports the PR not mergeable (e.g. dirty, closed)
- **THEN** the tool returns the status explanation and posts no approval request

### Requirement: Merge approval resolution executes or explains, identically from every surface

Approving a pending merge request SHALL cause the engine to re-check the PR with GitHub and merge it when it is open and mergeable per GitHub — with no Archie-side review-approval requirement — then notify the user via the PM; when not mergeable, it SHALL report why instead of merging. Denying SHALL result in no GitHub calls and no merge, with the denial recorded and the PM reactivated. The Slack buttons (`approve_merge`/`deny_merge`) and the API path (`POST /tasks/:id/approve` with `type: "merge"`) SHALL resolve through the same Task resolution methods. Every resolution surface SHALL carry the identity of the PR being resolved — Slack buttons in their payload, the API path in its request body (required for merge-type requests) — and SHALL pass it into the Task resolution methods, which SHALL verify it against the pending request atomically with clearing it: a synchronous read-compare-clear with no await between reading the pending request, comparing it to the expected PR, and clearing it. The pending request SHALL be cleared only on a matching resolution, so a stale, repeated, or mismatched resolution is a no-op: a resolution whose PR does not match the current pending request SHALL resolve nothing and mark the prompt as stale, even when the pending request is superseded while that resolution is in flight.

#### Scenario: Approval merges a mergeable PR (AC4)
- **WHEN** the user approves the pending merge request and GitHub reports the PR mergeable
- **THEN** the PR is merged and the PM is reactivated to notify the user

#### Scenario: Approval of a no-longer-mergeable PR explains (AC4)
- **WHEN** the user approves but GitHub reports the PR not mergeable
- **THEN** no merge occurs and the reason is recorded and surfaced to the user via the PM

#### Scenario: Zero review approvals still merge on explicit approval (AC5)
- **WHEN** the approved PR has zero GitHub review approvals but GitHub reports it mergeable
- **THEN** the merge proceeds

#### Scenario: Denial performs no merge (AC3)
- **WHEN** the user denies the pending merge request
- **THEN** no merge occurs, the denial is recorded, and the PM is reactivated

#### Scenario: Slack button and API path resolve identically (AC8)
- **WHEN** a merge approval is resolved via the Slack button and, on an equivalent task, via the API route
- **THEN** both invoke the same Task resolution methods with the same effects

#### Scenario: Stale resolution is a no-op
- **WHEN** an approval arrives for a task with no pending merge request (already resolved)
- **THEN** nothing is merged and the event is logged without error

#### Scenario: Click on a superseded prompt is a no-op
- **WHEN** an approve/deny click arrives from a prompt whose PR identity does not match the current pending request — including when a supersede rewrites the pending request mid-resolution, after the click was received but before it resolves
- **THEN** nothing is resolved or merged — the atomic compare rejects the resolution against the rewritten request — and the prompt's message is updated with a stale notice

### Requirement: Merge approval type is observable and resolvable in the debug MCP

The debug MCP SHALL surface a pending merge approval via `wait_for_task` as `STATE=approval_requested` with `APPROVAL_TYPE=merge`, and its `approve` tool SHALL accept `type: "merge"` together with the pending PR's identity (`github`, `pr_number`), forwarded in the API request body, to resolve it through the API path.

#### Scenario: wait_for_task surfaces the merge gate (AC3)
- **WHEN** `wait_for_task` observes a task paused on an unresolved `approval:requested` event with `approvalType: "merge"`
- **THEN** it returns `state: "approval_requested"` with `approval_type: "merge"`

#### Scenario: approve resolves a merge gate
- **WHEN** the `approve` tool is called with `type: "merge"`, `approve: false`, and the pending PR's `github`/`pr_number`
- **THEN** the task's merge request is denied via the standard API path and no merge occurs
