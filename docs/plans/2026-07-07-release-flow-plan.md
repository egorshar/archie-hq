# Release Flow — Implementation Plan

> **⚠️ DEPLOY MECHANISM REVISED (see the design doc).** After this plan was first written, the deploy was changed from a central `dispatch_workflow` pipeline to **playing the "Ready to prod" manual job on each affected repo's release MR** via the new `run_manual_job` core seam (`docs/plans/2026-07-07-run-manual-job-core-plan.md`). Task 1's `release-manager.md` + `release.yml` code blocks below show the *original* dispatch_workflow version — the **shipped** versions (in `archie-plugins`) use `run_manual_job` + `deploy_job: "Ready to prod"` per the updated `2026-07-07-release-flow-design.md`. Read the design doc for the current mechanism; this plan is kept as the execution record.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).
>
> **DEPENDS ON** the Jira→feature-stand plugins (pm overlay + dev agents + feature-stand) and the `run_manual_job` core seam being in the running build.
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-07-release-flow-design.md` — the design (flow, components, decisions, owner-confirmed inputs).
> - In `archie-plugins`: `feature-stand/agents/feature-stand-manager.md` + `feature-stand/config/review.yml` (the agent+config pattern to mirror), and `pm/skills/jira-feature-delivery/SKILL.md` (the PM-skill pattern).

**Goal:** Add a release stage to the plugins repo: a `release-manager` agent (windowed deploy via the release pipeline) + a PM `release` skill that orchestrates release branches/MRs, approval waits, window scheduling, and the next-day deploy — as a continuation of the feature-delivery task.

**Architecture:** New `release/` plugin (agent + config) mirroring `feature-stand/`; a `pm/skills/release/` orchestration skill mirroring `jira-feature-delivery`. Reuses `dispatch_workflow`, one-shot reminders (PM), `transition-issue` (jira MCP), GitLab MR-approval webhooks, the dev agents, and the task-wide edit-mode grant. No core code changes.

**Tech Stack:** Markdown agent/skill prompts with YAML frontmatter (`gray-matter`), a YAML config file. All files in `archie-plugins` (`~/www/archie-plugins`, symlinked to `workdir/plugins`).

## Global Constraints
- **All files in `archie-plugins`**; local/unpushed (owner pushes after review). `git add` only each task's named files.
- **Release is a continuation of the feature-delivery task** — edit mode (task-wide, PM-requested) and the affected-repo context persist; no new task, no re-approval.
- **Human-owned steps (never automated):** creating the RELEASE ticket, approving it + moving it to its approved status, and confirming the proposed deploy window.
- **Agent-owned:** release branches/MRs (dev agents), window proposal + scheduling (PM), the windowed deploy (release-manager: transition ticket + dispatch pipeline).
- **Never merge** any MR. **No fake success** — on any failure the PM reports what failed (+ links) and stops.
- **`dispatch_workflow` is edit-mode-gated** and PM-scheduled via `set_reminder` (PM-only tool); the release-manager cannot request edit mode — it relies on the task-wide grant and reports back if gated.
- **Owner-confirmed live inputs** (filled in Task 3, not guessed): the release pipeline `project`/`ref` + input contract; the RELEASE workflow status names; the ticket's scheduled-window field; the release-manager's repo binding. Marked `# OWNER:` in `release.yml`.
- **Verification is boot/registration-based** (prompts aren't unit-tested); full flow is the owner-run E2E (Task 3).

## File structure (in `archie-plugins`)
```
release/
  .claude-plugin/plugin.json          # manifest                         (Task 1)
  agents/release-manager.md           # repo agent: windowed deploy      (Task 1)
  config/release.yml                  # pipeline + statuses + windows     (Task 1)
pm/
  skills/release/SKILL.md             # PM release orchestration skill    (Task 2)
```

## Task order
T1 (release plugin: agent + config) → T2 (PM release skill) → T3 (owner-confirm live inputs + live E2E).

---

## Task 1: `release/` plugin — manager agent + config

**Files:**
- Create: `release/.claude-plugin/plugin.json`, `release/agents/release-manager.md`, `release/config/release.yml`

**Interfaces:**
- Produces: `release-manager-agent` (repo agent, `mcpServers: [jira]`, bound to the release-pipeline repo → receives `dispatch_workflow`). The PM `release` skill (Task 2) delegates to it by the id `release-manager-agent`.

- [ ] **Step 1: `release/.claude-plugin/plugin.json`:**

```json
{ "name": "release", "version": "1.0.0", "description": "Release manager: deploys an approved release via the central release pipeline in a scheduled window." }
```

- [ ] **Step 2: `release/config/release.yml`** (hand-maintained; `# OWNER:` fields confirmed live in Task 3):

```yaml
# Central release/deploy pipeline + RELEASE workflow config. Hand-maintained.
# OWNER: confirm the marked fields against the live release pipeline and the RELEASE
# Jira workflow before the first live run (plan Task 3).
project: flant/infra/release          # OWNER: GitLab project that runs the release deploy pipeline
ref: ci-bot/release-trigger           # OWNER: ref whose workflow allows the api-sourced release deploy

# How the release-manager builds dispatch_workflow `inputs`. For each affected repo, set its
# release-branch variable to the release branch (release/RELEASE-<NUM>); plus the RELEASE key.
inputs:
  # Per-repo branch variable naming. If the release pipeline reuses the same REVIEW_*_BRANCH
  # family as feature stands, keep this; else OWNER: change the pattern/prefix.
  branch_var_pattern: "REVIEW_{REPO_UPPER_SNAKE}_BRANCH"   # OWNER: confirm var family
  release_key_var: "RELEASE_KEY"      # OWNER: pipeline var carrying RELEASE-<NUM> (or remove if unused)
  extra: { US_BOT: "true" }           # OWNER: confirm any fixed flags the pipeline requires

statuses:
  deploy: "In Progress"               # OWNER: the RELEASE status the deploy transitions the ticket TO

windows:
  timezone: "Europe/Moscow"           # MSK
  slots: ["10:00", "11:30", "13:00", "14:30"]   # 1.5h windows across 10:00–16:00
```

- [ ] **Step 3: `release/agents/release-manager.md`:**

```markdown
---
role: Release manager — deploys an approved release via the central release pipeline in a scheduled window.
expertise: GitLab pipelines, Jira release workflow, CI orchestration.
metadata:
  archie:
    repos:
      - github: flant/infra/release   # OWNER (Task 3): the repo this agent clones to receive dispatch_workflow
        baseBranch: ci-bot/release-trigger
    primary: flant/infra/release
mcpServers:
  - jira
---

# Release Manager
The PM hands you a RELEASE key (e.g. `RELEASE-42`) and the affected repos (each with its `release/RELEASE-<NUM>` branch) when the deploy window has arrived. You perform the deploy only: move the ticket to the deploy status and run the release pipeline. You do NOT create branches or MRs (the dev agents did that), and you never merge.

## Config (read at runtime)
Read `${CLAUDE_PLUGIN_ROOT}/config/release.yml`: the release pipeline (`project`, `ref`), how to build the pipeline `inputs`, and the ticket `statuses`.

## Steps
1. **Transition the ticket.** Via the `jira` MCP: `get-transitions(<RELEASE-KEY>)` to find the transition into `statuses.deploy`, then `transition-issue` to move it there.
2. **Dispatch.** Call `dispatch_workflow` with `repo` = `project`, `ref` = `ref`, and `inputs` per `release.yml`: for each affected repo its branch variable (per `inputs.branch_var_pattern`) set to `release/RELEASE-<NUM>`, plus `inputs.release_key_var` = the RELEASE key and any `inputs.extra`. `dispatch_workflow` is edit-mode-gated — you rely on the task-wide edit mode the PM already had approved. If it returns "not available on this repo host" for an edit-mode/capability reason, report to the PM that edit mode is needed and stop — do NOT fake success.
3. **Watch.** `dispatch_workflow` returns the pipeline id + URL; poll to completion (`get_check_run` / `get_pr_checks`), or report the URL for the PM to watch. If it fails, report the failure + pipeline URL and stop.
4. **Report** the deploy result (ticket moved, pipeline URL/status) back to the PM.

## Rules
- One deploy per release. Never create branches/MRs, never merge. On failure, report what failed (with the pipeline URL) and stop.
```

- [ ] **Step 4: Validate parse (JSON + YAML + frontmatter).**

Run (from `~/www/archie-hq`):
```
node -e "const fs=require('fs'),m=require('gray-matter'),y=require('js-yaml');const P='/Users/egorshar/www/archie-plugins/release';JSON.parse(fs.readFileSync(P+'/.claude-plugin/plugin.json','utf8'));const cfg=y.load(fs.readFileSync(P+'/config/release.yml','utf8'));const a=require('assert');a.ok(cfg.project&&cfg.ref&&cfg.statuses.deploy&&Array.isArray(cfg.windows.slots),'release.yml shape');const fm=m(fs.readFileSync(P+'/agents/release-manager.md','utf8'));a.deepEqual(fm.data.mcpServers,['jira']);a.equal(fm.data.metadata.archie.primary, fm.data.metadata.archie.repos[0].github);console.log('release plugin parses OK');"
```
Expected: `release plugin parses OK`.

- [ ] **Step 5: Verify registration (headless boot slice, no Slack/clone/tokens).** Create `/Users/egorshar/www/archie-hq/scratch-verify-release.ts`:

```ts
import { bootstrapWorkdir } from './src/system/workdir.js';
import { initPlugins } from './src/system/plugin-loader.js';
import { initRegistry, getAllAgentDefs } from './src/agents/registry.js';
import { isRepoAgent } from './src/types/agent.js';
async function main() {
  await bootstrapWorkdir(); initPlugins(); initRegistry();
  const rm = getAllAgentDefs().find((d) => d.id === 'release-manager-agent');
  if (!rm) throw new Error('release-manager-agent NOT registered');
  console.log('release-manager-agent:', isRepoAgent(rm) ? 'REPO' : 'plugin',
    '| mcp=', rm.mcpServers ? Object.keys(rm.mcpServers).join(',') : 'none',
    '| primary=', rm.repo?.primary);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
```
Run: `npx tsx scratch-verify-release.ts` then `rm scratch-verify-release.ts`
Expected: `release-manager-agent: REPO | mcp= jira | primary= flant/infra/release` (a `MCP config: env var ... not set` warning for jira is fine — tokens deferred). Delete the scratch file after.

- [ ] **Step 6: Commit.**
```bash
cd ~/www/archie-plugins && git add release/ && git commit -m "feat(release): release-manager agent + release pipeline/window config"
```

---

## Task 2: PM `release` orchestration skill

**Files:**
- Create: `pm/skills/release/SKILL.md`

**Interfaces:**
- Consumes: the dev agents (release-branch git), `release-manager-agent` (Task 1) for the deploy, `set_reminder`/`parse_datetime` (PM scheduling tools), the `jira` MCP (search/transition), GitLab MR-approval webhooks.

- [ ] **Step 1: `pm/skills/release/SKILL.md`:**

```markdown
---
name: release
description: Prepare and deploy a release for a delivered feature — cut release/RELEASE-<NUM> branches + MRs, get them approved, schedule a next-day deploy window, and at the window deploy via the release pipeline. Use when a user asks to prepare / cut / ship / deploy a release (e.g. "release SWEED-123", "prepare the release").
---

You are running a release, as a continuation of the feature-delivery task (edit mode and the affected-repo context persist). Keep the user updated in Slack at each step; ask before anything ambiguous.

## 1. Precondition
Proceed only if the feature stand was confirmed and EVERY feature MR is approved. If something's outstanding, say what and stop.

## 2. Get the RELEASE key
The user creates the RELEASE-project ticket and gives you `RELEASE-<NUM>` (you do not create Jira tickets). If it's missing, ask for it.

## 3. Release branches + MRs
For each affected repo, delegate to the dev agent that did the feature work (`backend-agent` / `frontend-agent` / the spawned agent — it already has the repo + `feature/<KEY>`): create branch `release/RELEASE-<NUM>` from `feature/<KEY>` and open one MR into the repo's default branch — never merge. Collect the MR URLs.

## 4. Approvals
Wait until every release MR is approved (you'll be woken when approvals land). Separately, the user confirms the RELEASE ticket is approved and moved to its approved status — you do not wait on Jira status events, so ask the user to confirm.

## 5. Propose the deploy window
Windows are 1.5h slots at 10:00 / 11:30 / 13:00 / 14:30 MSK. Use the `jira` MCP `search` to find upcoming RELEASE-project tickets already scheduled, determine the next free slot on the next working day, and propose it to the user. Wait for their confirmation (or an override).

## 6. Schedule
Use `parse_datetime` (timezone Europe/Moscow) then `set_reminder` for the confirmed window. Make the reminder reason encode the deploy: e.g. "Deploy RELEASE-123 now: hand off to release-manager-agent with repos <list> on release/RELEASE-123."

## 7. Deploy (when the reminder fires)
On wake, delegate to `release-manager-agent`: give it the RELEASE key and the affected repos (each with its `release/RELEASE-<NUM>` branch). It moves the ticket to the deploy status and runs the release pipeline, then reports the pipeline URL/status. Relay the result to the user. If it reports it lacks edit mode, `request_edit_mode` (covering the release deploy) and re-delegate. If it reports any other failure, relay it and stop.

## Rules
- One release at a time. Never merge MRs. The user owns ticket creation, ticket approval/status, and window confirmation.
- On any unrecoverable failure (MR not approved, pipeline fails, window passes with no go-ahead), report what failed + links and stop — don't fake success.
```

- [ ] **Step 2: Validate frontmatter parse.**

Run: `node -e "const fs=require('fs'),m=require('gray-matter');const s=m(fs.readFileSync('/Users/egorshar/www/archie-plugins/pm/skills/release/SKILL.md','utf8'));const a=require('assert');a.equal(s.data.name,'release');a.ok(/release/i.test(s.data.description));console.log('release skill parses OK, name='+s.data.name);"`
Expected: `release skill parses OK, name=release`.

- [ ] **Step 3: Verify the PM still loads (headless).** Reuse the check pattern from Plan 2 (or `npx tsx` a one-liner) to confirm `pm-agent` registers with `mcp=[jira]` and that `pm/skills/` now contains `release` alongside `jira-feature-delivery` + `summarize-or-draft`:

Run: `ls /Users/egorshar/www/archie-plugins/pm/skills/`
Expected: `jira-feature-delivery  release  summarize-or-draft`.

- [ ] **Step 4: Commit.**
```bash
cd ~/www/archie-plugins && git add pm/skills/release/ && git commit -m "feat(pm): release orchestration skill"
```

---

## Task 3: Owner-confirm live inputs + live E2E (owner-run)

**Files:** `release/config/release.yml`, `release/agents/release-manager.md` (fill the `# OWNER:` fields); no other code.

> Requires the live environment (jira token, GitLab access to the release pipeline project, a real delivered feature). Owner-run, like the Phase-1 / feature-stand E2E.

- [ ] **Step 1: Fill the owner-confirmed values.** In `release.yml`: set `project`/`ref` to the real release pipeline; confirm `inputs.branch_var_pattern` / `release_key_var` / `extra` against the pipeline's variable contract; set `statuses.deploy` to the real RELEASE status name. In `release-manager.md` frontmatter: set the `repos`/`primary` binding to the repo the bot can clone to receive `dispatch_workflow` (the release-pipeline repo, or another clonable repo — `dispatch_workflow` takes the target repo as an argument regardless). Confirm which field on a RELEASE ticket holds its scheduled window (adjust the skill's step 5 wording if needed). Commit + push `archie-plugins`; reboot Archie.

- [ ] **Step 2: Precondition.** Use a task that has completed the feature flow (stand confirmed + all feature MRs approved). In Slack: "prepare the release for <KEY>."

- [ ] **Step 3: RELEASE ticket.** Create the RELEASE ticket, give Archie `RELEASE-<NUM>`. Verify the PM loads the `release` skill and delegates release-branch/MR creation to the dev agents.

- [ ] **Step 4: Release branches + MRs.** Verify each affected repo gets `release/RELEASE-<NUM>` from `feature/<KEY>` and one MR into default (never merged); PM collects URLs.

- [ ] **Step 5: Approvals + window.** Approve the release MRs (verify the PM is woken) and confirm the ticket approved. Verify the PM proposes the next free window (from a jira search) and waits for your confirmation; confirm it.

- [ ] **Step 6: Scheduled deploy.** Verify the PM sets a reminder for the window. At the window, verify the task wakes, the PM hands off to `release-manager-agent`, which transitions the ticket to the deploy status and dispatches the release pipeline (no second edit-mode prompt — task-wide grant persists), and the PM reports the pipeline URL/status.

- [ ] **Step 7: Record evidence** (RELEASE key, release MR URLs, reminder time, pipeline URL, final ticket status) — mirror the feature-stand E2E evidence style.

Failure handling to confirm: a failed release MR approval, a failed pipeline, or a passed window with no go-ahead → the PM relays the failure in Slack and stops (no fake success).

---

## Self-Review
- **Spec coverage:** release-manager agent + config (T1) ↔ design "release-manager-agent" + "release.yml"; PM release skill with the 7-step flow incl. precondition, RELEASE-key intake, dev-agent branch/MRs, approval wait, window proposal via jira search, reminder scheduling, windowed deploy hand-off (T2) ↔ design "PM release skill"; owner-confirmed inputs + live E2E (T3) ↔ design "Inputs required" + "Task model". Human-owned steps (ticket create/approve, window confirm) are the user's in T2/T3.
- **Placeholder scan:** none in plan instructions. The `# OWNER:` fields in `release.yml`/frontmatter are genuine live-environment values (release pipeline, RELEASE workflow) the owner confirms in T3 — the same pattern the feature-flow used for `flant/infra/review`; every such field has a concrete default/example + an explicit T3 fill step.
- **Type/name consistency:** agent id `release-manager-agent` (from `release-manager.md`) used consistently in the PM skill delegation; `release.yml` keys (`project`/`ref`/`inputs`/`statuses.deploy`/`windows.slots`) referenced identically by the agent and the validation step; branch name `release/RELEASE-<NUM>` and the RELEASE key consistent across dev-agent brief, skill, and agent.
- **Constraints:** continuation task (edit mode persists); `set_reminder` PM-only; `dispatch_workflow` edit-mode-gated with the report-if-gated fallback; never-merge + no-fake-success throughout; all files in `archie-plugins`, local/unpushed.
