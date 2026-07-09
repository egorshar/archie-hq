# Design — Release flow (release-manager + PM `release` skill)

> Brainstorming output (design doc). Next SDLC stage after the Jira→dev→feature-stand flow (see `2026-07-06-jira-feature-flow-design.md`). Once the feature stand is confirmed and every feature MR is approved, Archie prepares and deploys a release: release branches + MRs, a scheduled next-day windowed deploy via a special pipeline. Reuses `dispatch_workflow`, one-shot reminders, `transition-issue`, GitLab MR-approval webhooks, the dev agents, and the task-wide edit-mode grant.

## Goal
After a feature is delivered (stand confirmed + all feature MRs approved), take it to production through the org's release process: cut `release/RELEASE-<NUM>` branches + MRs across the affected repos, get them approved, and — in a chosen next-day deploy window (10:00–16:00 MSK, 1.5h slots) — transition the RELEASE ticket to its deploy status and run the release pipeline. Coordination the org expects a human to own (creating the RELEASE ticket, approving it, confirming the window) stays with the human; the mechanical work is the agents'.

## Task model
Release is a **continuation of the same task** as the feature delivery. The feature-delivery task's **task-wide edit-mode grant persists** (so `dispatch_workflow` and repo writes stay ungated), the affected-repo context and `feature/<KEY>` branches are already known, and a one-shot reminder keeps the single task alive across to the next-day window. No new task, no re-approval of edit mode.

## Components

### PM `release` skill (`pm/skills/release/SKILL.md`)
Orchestration, loaded on demand (trigger-rich description: "prepare/cut/ship a release", "release SWEED-123"). Steps:
1. **Precondition.** Only proceed once the feature flow has confirmed the stand and *all* feature MRs are approved. If not, say what's outstanding and stop.
2. **Get the RELEASE key.** The human creates the RELEASE-project ticket and gives you `RELEASE-<NUM>` (Archie does not create Jira tickets). If it's missing, ask for it.
3. **Release branches + MRs.** For each affected repo, delegate to the dev agent that did the feature work (it already has the repo + `feature/<KEY>` mounted): create `release/RELEASE-<NUM>` from the feature branch and open the release MR into the repo's default branch (never merge). Collect the MR URLs.
4. **Approvals.** Wait for every release MR to be approved (surfaced via the GitLab MR-approval webhook). Separately, the **human confirms** the RELEASE ticket is approved and moved to its approved status (Archie does not wait on Jira status events).
5. **Propose the window.** `search` the RELEASE project (jira MCP) for upcoming release tickets' scheduled slots, determine the next free window (10:00 / 11:30 / 13:00 / 14:30 MSK, next working day), **propose it to the human, and wait for confirmation** (or an override).
6. **Schedule.** `set_reminder` for the confirmed window, with a reason that encodes the deploy intent (e.g. "Deploy RELEASE-123 in the 13:00 MSK window: hand off to release-manager-agent").
7. **Deploy (on wake).** When the reminder fires, the task reactivates and you receive the reminder reason. Delegate to `release-manager-agent` with the RELEASE key + the affected repos (and their `release/RELEASE-<NUM>` branch). It transitions the ticket and runs the pipeline; relay its result (deploy status + pipeline URL) to the human.

### `release-manager-agent` (`release/agents/release-manager.md`)
A repo agent (bound to a repo it can clone so it receives the `run_manual_job` repo tool), frontmatter `mcpServers: [jira]`. Reads `${CLAUDE_PLUGIN_ROOT}/config/release.yml`. The deploy is **not** a pipeline dispatch — each affected repo's release MR carries a manual CI job named **"Ready to prod"** that must be *played*. Job = the windowed deploy only:
1. For **each affected repo**, play its release MR's manual job via `run_manual_job(repo, <release MR #>, "Ready to prod")` (the new core seam — see below). Collect the played-job URLs/status.
2. Once all "Ready to prod" jobs have started, transition the RELEASE ticket to the deploy status once (`transition-issue`; `get-transitions` to resolve the id).
3. Watch the played jobs (`get_check_run` / `get_pr_checks`), then report the deploy result + job URLs to the PM.
Never merges, never creates branches/MRs. On failure, report what failed (with links) and stop — no fake success. It cannot request edit mode itself; it relies on the task-wide grant (report back to the PM if `run_manual_job` comes back gated). It receives the affected repos + their release MR numbers from the PM (the dev agents opened those MRs).

### Core addition — `archie-hq`: `run_manual_job` seam
Playing a manual CI job has no existing capability (`dispatch_workflow` *creates a pipeline*; it can't play a job). A new Plan-1-style seam:
- `RepoHost.runManualJob(repo, prNumber, jobName): Promise<{ id, url, status }>` — GitLab: resolve the MR's head pipeline, find the manual job named `jobName`, `POST /projects/:id/jobs/:jobId/play`. GitHub: **capability-off stub** — no clean 1:1 (nearest is approving a pending deployment, `pending_deployments`), deferred (YAGNI), like `dispatch_workflow`'s GitHub side.
- Capability `manualJobs` (GitLab `true`, GitHub `false`). MCP tool `run_manual_job` (capability-gated) added to `REPO_TOOLS_REQUIRING_EDIT_MODE` — it's a prod deploy, same gate as `dispatch_workflow`.

### `release/config/release.yml` (hand-maintained, like `feature-stand/config/review.yml`)
- `deploy_job` — the manual job name to play (`"Ready to prod"`).
- `statuses` — the RELEASE workflow status name the agent transitions to at deploy (and any it must check).
- `windows` — 10:00–16:00 MSK, 1.5h slots (the four start times), timezone MSK. (Referenced by the PM skill, which owns windowing; see the plan — the PM can't read this plugin's config, so the slots live in the skill and this is documentation.)
No `project`/`ref`/pipeline-input fields — the deploy plays a job on each repo's *own* release MR, not a central pipeline.

## What's delegated to the human
- Creates the RELEASE ticket (resolves the missing jira `create-issue` capability).
- Confirms the ticket is approved + moved to its approved status (resolves the lack of Jira status-change eventing).
- Confirms (or overrides) the proposed deploy window.
Everything else — release branches, release MRs, scheduling, and the windowed deploy — is the agents'.

## Reused mechanisms (verified against the code)
- **Scheduling:** one-shot per-task reminder (`parse_datetime` + `set_reminder`, PM-only); the scheduler reactivates the task and routes the reminder reason to the PM (`reminder-scheduler.ts` → `task.sendMessage(AGENT_PROMPTS.reminder(...))`).
- **Deploy:** `run_manual_job` (new edit-mode-gated repo tool — plays "Ready to prod" per affected repo's release MR) + `transition-issue` (jira MCP).
- **Approvals:** GitLab MR-approval webhooks (Phase 1/3) for release MRs; human confirmation for the ticket.
- **Edit mode:** task-wide, PM-requested, human-approved — persists from the feature phase into the release/deploy on the same task.

## Failure handling
Any unrecoverable failure — a release MR isn't approved, a "Ready to prod" job fails, the window passes without a go-ahead, or `run_manual_job` comes back gated — the PM reports what failed (with links) to the human and stops. No autonomous retries, no faked success.

## Inputs required (confirm against live)
- **Jira:** which field holds a RELEASE ticket's scheduled window (due date or a custom field), and the exact RELEASE workflow status name for the deploy transition.
- **Deploy job name:** confirm the manual job is named exactly `"Ready to prod"` on the release MRs (per repo).
- **release-manager repo binding:** the repo it clones to receive `run_manual_job` (any clonable repo — `run_manual_job` takes the target repo + MR as arguments regardless).
- **`GITLAB_TOKEN`** must have API access to each affected repo to read its MR pipeline + play the job.

## Decisions (locked)
- New `release-manager-agent` (separate `release/` plugin) for the windowed deploy; dev agents do the release-branch git; PM `release` skill orchestrates.
- **Deploy = play the "Ready to prod" manual job per affected repo's release MR** (new `run_manual_job` core seam), not a central pipeline dispatch. `dispatch_workflow` stays feature-stand-only.
- Ticket transitioned to the deploy status **once**, after all "Ready to prod" jobs have started.
- Deploy auto-fires in the confirmed window (agent, via reminder) — the human's role ends at the go-ahead.
- Window: agent proposes the next free slot (from a jira `search` of the RELEASE project), human confirms.
- Release is a continuation of the feature-delivery task (edit mode + context persist).
- Human owns: RELEASE ticket creation, ticket approval/status, window confirmation.
- `run_manual_job` GitHub side is a capability-off stub (no clean 1:1; nearest is pending-deployment approval — deferred).

## Out of scope
- Archie creating or approving Jira tickets (human-owned).
- Waiting on Jira status-change events (no Jira webhooks; human confirms).
- Autonomous window-collision management beyond proposing from a jira search.
- Rollback / hotfix flow (a later stage).
- Merging release branches to default after deploy (a later stage / human-owned).
