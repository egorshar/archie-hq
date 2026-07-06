# Jira Flow · Plan 2 — plugins (`archie-plugins` repo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).
>
> **DEPENDS ON Plan 1** (`dispatch_workflow` core seam) being merged and the Archie instance built from a branch that includes it — the feature-stand-manager needs the `dispatch_workflow` tool.
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-06-jira-feature-flow-design.md` — the design (flow, components, decisions, the concrete repos/pipeline/MCP values).
> - `/Users/egorshar/www/universal-soldier/{config.yml,repos.yml,universal-soldier.md}` — the mechanics being ported (Jira MCP tool set, review pipeline trigger, repo fields, MR-per-repo/never-merge).
> - `examples/plugins/{pm/agents/pm.md,helper/agents/assistant.md,.claude-plugin/plugin.json}` in `archie-hq` — the plugin/agent file format to mirror.

**Goal:** Configure the `archie-plugins` repo so Archie's PM implements the Jira→dev→feature-stand flow: pull Jira context (MCP), map feature→repos via Confluence (MCP), confirm in Slack, delegate to hybrid dev agents (standing backend/frontend + dynamic spawn), one MR per repo (never merge), then a feature-stand-manager deploys via the central werf pipeline (`dispatch_workflow`) and the PM reports stand + MR links and posts one closing Jira comment.

**Architecture:** All files live in the `archie-plugins` repo (`git@gitlab.walli.com:e.sharapov/archie-plugins.git`). These are agent prompts + YAML config + MCP wiring — no code. Verification is **boot + agent-registration checks + a live E2E** (prompts aren't unit-tested). Each agent reads only its own plugin dir via `${CLAUDE_PLUGIN_ROOT}`; `dispatch_workflow` is a repo tool, so the feature-stand-manager is a repo agent.

**Tech Stack:** Markdown agent prompts with YAML frontmatter (`gray-matter`), a root `.mcp.json` (remote MCP, `${MCP_*}` substitution), YAML config files.

## Global Constraints
- **Work in a fresh clone** of `archie-plugins` (not `workdir/plugins`, whose files are owned by the container uid). Commit as your GitLab-verified email (push rule), push to `main`; Archie re-clones on reboot.
- **Frontmatter repo ids are GitLab `group/project` paths** (`path_with_namespace`), matching `repos.yml` `clone`. Base branch `master` for these repos.
- **Branch for dev work is `feature/<KEY>`** (matches the review pipeline's `review_branch_var`).
- **Never merge** MRs. **Jira write-back = one closing comment** (`add-comment`); no transition/label change.
- **Secrets:** none in files. MCP tokens via `${MCP_JIRA_TOKEN}` / `${MCP_CONFLUENCE_TOKEN}` (set in Archie's env). The pipeline trigger uses `dispatch_workflow` (in-process; no token in any agent).
- **Verification is boot-based:** after each task, boot Archie (or reboot) and confirm the change loads (agent registers / MCP connects / config reads). Full live E2E is Task 5.

## File structure (in `archie-plugins`)
```
.mcp.json                              # jira + confluence remote MCP  (Task 1)
pm/
  .claude-plugin/plugin.json
  agents/pm.md                         # PM overlay: frontmatter mcpServers + orchestration  (Task 2)
backend/
  .claude-plugin/plugin.json
  agents/backend.md                    # repo agent: walli/sweed/server, sd/service/shop-api  (Task 3)
frontend/
  .claude-plugin/plugin.json
  agents/frontend.md                   # repo agent: the three web-ui repos  (Task 3)
feature-stand/
  .claude-plugin/plugin.json
  agents/feature-stand-manager.md      # repo agent (flant/infra/review) + dispatch_workflow  (Task 4)
  config/repos.yml                     # per-repo review_branch_var + stand_url  (Task 4)
  config/review.yml                    # central pipeline config  (Task 4)
```
(If a `helper`/assistant plugin already exists, leave it.)

## Task order
T1 (MCP wiring) → T2 (PM overlay) → T3 (standing dev agents) → T4 (feature-stand plugin + config) → T5 (live E2E).

---

## Task 1: MCP wiring (`.mcp.json` + env)

**Files:** Create/replace `.mcp.json` at the repo root.

- [ ] **Step 1: Ensure the env vars exist in Archie's `.env`** (`archie-hq/.env`): `MCP_JIRA_TOKEN`, `MCP_CONFLUENCE_TOKEN` (bearer tokens for `https://1bf.sweed.tech/mcp/a/{jira,confluence}`). Add them if missing.

- [ ] **Step 2: Write `.mcp.json`:**

```json
{
  "mcpServers": {
    "jira": {
      "type": "http",
      "url": "https://1bf.sweed.tech/mcp/a/jira",
      "headers": { "Authorization": "Bearer ${MCP_JIRA_TOKEN}" },
      "description": "Jira (PII-filtered, project-allowlisted). Tools: search, get-issue, update-issue, add-comment, transition-issue, get-transitions. Own comments come back is_bot:true."
    },
    "confluence": {
      "type": "http",
      "url": "https://1bf.sweed.tech/mcp/a/confluence",
      "headers": { "Authorization": "Bearer ${MCP_CONFLUENCE_TOKEN}" },
      "description": "Confluence. Read the Repositories / Code ownership doc (space TD, page 18251913) to map a feature to affected repos."
    }
  }
}
```

- [ ] **Step 3: Commit + push, then boot Archie and verify the MCP connects.**

```bash
git add .mcp.json && git commit -m "feat(mcp): jira + confluence remote MCP servers" && git push
```
Then (in `archie-hq`): reboot and check the boot/PM logs for the MCP connection once the PM has frontmatter referencing them (Task 2). At this task, verify only that `.mcp.json` parses (no boot error like "failed to parse .mcp.json"). If the PM already references them, expect `[pm-agent] MCP jira: connected` / `MCP confluence: connected`.

> If a server logs a transport error, switch `"type": "http"` → `"type": "sse"` for that server (the MCP host may speak SSE rather than streamable-HTTP). Verify which the `1bf.sweed.tech` MCP uses.

---

## Task 2: PM overlay (`pm/agents/pm.md`)

**Files:** Create `pm/.claude-plugin/plugin.json` + `pm/agents/pm.md`.

**Interfaces:** The PM gains `jira` + `confluence` MCP (frontmatter) and the orchestration behavior. It delegates to `backend-agent`/`frontend-agent` (Task 3) and `feature-stand-manager` (Task 4), and uses `spawn_repo_agent` for uncovered repos.

- [ ] **Step 1: `pm/.claude-plugin/plugin.json`:**

```json
{ "name": "pm", "version": "1.0.0", "description": "PM overlay: Jira/Confluence-driven feature delivery orchestration." }
```

- [ ] **Step 2: `pm/agents/pm.md`** (frontmatter grants MCP; body is appended to the PM system prompt):

```markdown
---
mcpServers:
  - jira
  - confluence
---

# Feature delivery from Jira

When a user asks you to implement a Jira ticket (e.g. "implement SWEED-123"), run this flow. Keep the user updated in Slack at each step; ask before doing anything ambiguous.

## 1. Load the ticket
Use the `jira` MCP only (never Jira REST): `get-issue(<KEY>)` for the summary, description, acceptance criteria, story points, and labels. Ignore any comments tagged `is_bot:true` (they're yours). If the key is missing/invalid, ask the user.

## 2. Decide affected repos (Confluence)
Read the ownership doc via the `confluence` MCP — "Repositories / Code ownership" (space `TD`, page id `18251913`). Using the ticket text + each repo's description in that doc, decide which repos this feature touches. When unsure, ask the user rather than guess.

## 3. Confirm in Slack
Post the proposed affected repos to the user ("I'll touch `walli/sweed/server` + `walli/sweed/web-ui-portal-ci` — proceed?") and wait for confirmation before delegating. This guards against wrong-repo work.

## 4. Delegate implementation (hybrid)
For each confirmed repo:
- **Standing coverage** — if the repo is one of these, delegate to that agent:
  - `backend-agent`: `walli/sweed/server`, `sd/service/shop-api`
  - `frontend-agent`: `walli/sweed/web-ui-portal-ci`, `walli/sweed/web-ui-cashier-ci`, `sd/web-ui-shop`
- **Otherwise** — `spawn_repo_agent` for that repo (pass its `group/project` path from the Confluence doc), then delegate to the spawned agent.
Give each developer: the ticket key, summary, acceptance criteria, the repo's Confluence "details", and the instruction to **work on branch `feature/<KEY>`, implement the acceptance criteria minimally, and open one MR per repo into the repo's default branch — never merge**. Approve edit mode when they request it (or relay the request to the user if a human gate is desired).

## 5. Feature stand
Once every developer has reported its MR open, delegate to `feature-stand-manager`: give it the ticket key and the list of affected repos (their `group/project` paths). It deploys one feature stand via the central review pipeline and returns the stand URL(s) + pipeline URL. If it reports a failure, relay it and stop.

## 6. Report + close
Post to the user in Slack: the stand URL(s) and every MR link. Then post **one closing comment** on the Jira ticket via `add-comment` — the MR URL(s) and stand URL(s) — and do nothing else to Jira (no status/label change). The user tests the stand.

## Rules
- One ticket at a time. Never merge MRs. Never invent repos not in the ownership doc.
- On any unrecoverable failure (dev can't finish, pipeline fails), report what failed + links to the user in Slack and stop — don't fake success.
```

- [ ] **Step 3: Commit + push, reboot, verify.**

```bash
git add pm/ && git commit -m "feat(pm): Jira/Confluence feature-delivery orchestration overlay" && git push
```
Reboot Archie; verify boot logs show `[pm-agent] MCP jira: connected` and `MCP confluence: connected`, and no frontmatter parse warnings. (Live behavior is exercised in Task 5.)

---

## Task 3: Standing dev agents (`backend`, `frontend`)

**Files:** Create `backend/.claude-plugin/plugin.json`, `backend/agents/backend.md`, `frontend/.claude-plugin/plugin.json`, `frontend/agents/frontend.md`.

**Interfaces:** Two repo agents (`backend-agent`, `frontend-agent`) bound to the common repos; the PM (Task 2) routes to them by name.

- [ ] **Step 1: `backend/.claude-plugin/plugin.json`:**
```json
{ "name": "backend", "version": "1.0.0", "description": "Backend engineering agent (server, shop-api)." }
```

- [ ] **Step 2: `backend/agents/backend.md`:**
```markdown
---
role: Backend engineer for the server and shop-api services.
expertise: Node/TypeScript backend services, APIs, git workflow, merge requests.
metadata:
  archie:
    repos:
      - github: walli/sweed/server
        baseBranch: master
      - github: sd/service/shop-api
        baseBranch: master
    primary: walli/sweed/server
---

# Backend Agent
You implement backend changes for a Jira ticket in the repo(s) the PM assigns.

## How you work
1. Investigate read-only first — read the relevant code before changing anything.
2. Request edit mode with a short reason, then wait for approval.
3. Implement the acceptance criteria with the smallest focused change (DRY, YAGNI); follow the repo's own conventions (its AGENTS.md/README win). Use TDD where the repo supports it.
4. Work on branch `feature/<TICKET-KEY>` (the PM gives you the key). Commit referencing the key, push, and open **one merge request into the repo's default branch — never merge it**.
5. Report the MR URL back to the PM, then stop.

## Stopping points
- After requesting edit mode (until approved).
- After opening the MR and reporting the URL.
- When the request is ambiguous — ask one question, then stop.
- On unrecoverable failure — report what failed (with links) and stop.
```

- [ ] **Step 3: `frontend/.claude-plugin/plugin.json`:**
```json
{ "name": "frontend", "version": "1.0.0", "description": "Frontend engineering agent (portal, cashier, shop web UIs)." }
```

- [ ] **Step 4: `frontend/agents/frontend.md`** (same body as backend, different identity + repos):
```markdown
---
role: Frontend engineer for the portal, cashier, and shop web UIs.
expertise: TypeScript/JS web UIs, components, git workflow, merge requests.
metadata:
  archie:
    repos:
      - github: walli/sweed/web-ui-portal-ci
        baseBranch: master
      - github: walli/sweed/web-ui-cashier-ci
        baseBranch: master
      - github: sd/web-ui-shop
        baseBranch: master
    primary: walli/sweed/web-ui-portal-ci
---

# Frontend Agent
You implement frontend changes for a Jira ticket in the repo(s) the PM assigns.

## How you work
1. Investigate read-only first — read the relevant code before changing anything.
2. Request edit mode with a short reason, then wait for approval.
3. Implement the acceptance criteria with the smallest focused change (DRY, YAGNI); follow the repo's own conventions. Use TDD where the repo supports it.
4. Work on branch `feature/<TICKET-KEY>`. Commit referencing the key, push, and open **one merge request into the repo's default branch — never merge it**.
5. Report the MR URL back to the PM, then stop.

## Stopping points
- After requesting edit mode (until approved).
- After opening the MR and reporting the URL.
- When ambiguous — ask one question, then stop.
- On unrecoverable failure — report what failed (with links) and stop.
```

- [ ] **Step 5: Commit + push, reboot, verify.**
```bash
git add backend/ frontend/ && git commit -m "feat(agents): standing backend + frontend repo agents" && git push
```
Reboot; verify boot logs register `backend-agent` (primary `walli/sweed/server`) and `frontend-agent` (primary `walli/sweed/web-ui-portal-ci`), and that Archie clones those repos (`Cloning …` / `Pulling latest for …`). If any repo fails to clone, the bot lacks access to it — fix access before Task 5.

---

## Task 4: feature-stand plugin (agent + config)

**Files:** Create `feature-stand/.claude-plugin/plugin.json`, `feature-stand/agents/feature-stand-manager.md`, `feature-stand/config/repos.yml`, `feature-stand/config/review.yml`.

**Interfaces:** Consumes the `dispatch_workflow` tool (Plan 1) — available because this is a repo agent. Reads `${CLAUDE_PLUGIN_ROOT}/config/*.yml`. Produces `feature-stand-manager` that the PM delegates to.

> The agent must be a **repo agent** to receive `dispatch_workflow` (a repo tool). Bind it to `flant/infra/review` (the pipeline repo) — the bot needs read access to clone it. If cloning that repo is undesirable/unavailable, bind it instead to a small repo the bot can clone; `dispatch_workflow` takes the target repo as an argument regardless.

- [ ] **Step 1: `feature-stand/.claude-plugin/plugin.json`:**
```json
{ "name": "feature-stand", "version": "1.0.0", "description": "Feature-stand manager: deploys a feature stand via the central review pipeline." }
```

- [ ] **Step 2: `feature-stand/config/review.yml`** (from universal-soldier `config.yml` review block):
```yaml
project: flant/infra/review            # GitLab project id 290 that deploys feature stands
ref: ci-bot/us-trigger                 # branch whose workflow allows api-source when US_BOT=true
namespace_template: feature-{ticket_lower}   # must match ^feature-[a-zA-Z-]{1,10}-[0-9]{1,8}$
existing_namespaces_file: vars/namespace-options.yml@ci-bot/variables
```

- [ ] **Step 3: `feature-stand/config/repos.yml`** (per-repo review fields; CI-generatable — seeded from universal-soldier `repos.yml`, keyed by `group/project`):
```yaml
walli/sweed/web-ui-portal-ci:
  review_branch_var: REVIEW_WEB_UI_PORTAL_CI_BRANCH
  stand_url: "https://feature-{ticket_lower}.sweedpos.com"
walli/sweed/server:
  review_branch_var: REVIEW_SERVER_BRANCH
  # no stand_url: backend, reached via a frontend stand
sd/service/shop-api:
  review_branch_var: REVIEW_SHOP_API_BRANCH
walli/sweed/web-ui-cashier-ci:
  review_branch_var: REVIEW_WEB_UI_CASHIER_CI_BRANCH
  stand_url: "https://cashier-feature-{ticket_lower}.sweedpos.com"
sd/web-ui-shop:
  review_branch_var: REVIEW_WEB_UI_SHOP_BRANCH
  stand_url: "https://web-ui-feature-{ticket_lower}.sweedpos.com"
```

- [ ] **Step 4: `feature-stand/agents/feature-stand-manager.md`:**
```markdown
---
role: Feature-stand manager — deploys a feature stand via the central review pipeline.
expertise: GitLab pipelines, werf review namespaces, CI orchestration.
metadata:
  archie:
    repos:
      - github: flant/infra/review
        baseBranch: ci-bot/us-trigger
    primary: flant/infra/review
---

# Feature-Stand Manager
The PM gives you a ticket key and the list of affected repos (`group/project` paths). You deploy ONE feature stand for them via the central review pipeline, then report the stand URL(s).

## Config (read at runtime)
Read `${CLAUDE_PLUGIN_ROOT}/config/review.yml` (pipeline: `project`, `ref`, `namespace_template`, `existing_namespaces_file`) and `${CLAUDE_PLUGIN_ROOT}/config/repos.yml` (per affected repo: `review_branch_var`, optional `stand_url`).

## Steps
1. **Namespace.** Compute it from `namespace_template` with `{ticket_lower}` = the lowercased ticket key (e.g. `feature-sweed-123`). It must match `^feature-[a-zA-Z-]{1,10}-[0-9]{1,8}$`.
2. **New vs existing.** Read `existing_namespaces_file` (via the repo tools / your read access). If the namespace is already listed, you'll pass it as `WERF_EXISTED_NAMESPACE`; otherwise as `WERF_NEW_NAMESPACE`.
3. **Dispatch.** Call the `dispatch_workflow` tool with:
   - `repo` = `review.yml` `project` (`flant/infra/review`)
   - `ref` = `review.yml` `ref` (`ci-bot/us-trigger`)
   - `inputs` = `{ US_BOT: "true", <WERF_NEW|EXISTED>_NAMESPACE: "<namespace>", and for EACH affected repo its repos.yml review_branch_var: "feature/<KEY>" }`
   Example inputs: `{ "US_BOT": "true", "WERF_NEW_NAMESPACE": "feature-sweed-123", "REVIEW_SERVER_BRANCH": "feature/SWEED-123", "REVIEW_WEB_UI_PORTAL_CI_BRANCH": "feature/SWEED-123" }`
4. **Watch.** `dispatch_workflow` returns the pipeline id + URL. Poll it to completion with `get_check_run`/`get_pr_checks` (or report the URL for the PM to watch if polling isn't available). If it fails, report the failure + pipeline URL and stop.
5. **Stand URLs.** For each affected repo that has a `stand_url` in `repos.yml`, substitute `{ticket}`→the key and `{ticket_lower}`→its lowercase form. Repos without `stand_url` (e.g. `server`) deploy into the same namespace but have no own URL — don't report one for them. Report the frontend stand URL(s) + the pipeline URL back to the PM.

## Rules
- Never merge anything. You only trigger + watch the pipeline and derive URLs.
- One dispatch per feature. On failure, report what failed (with the pipeline URL) and stop.
```

- [ ] **Step 5: Commit + push, reboot, verify.**
```bash
git add feature-stand/ && git commit -m "feat(feature-stand): manager agent + review/repos config" && git push
```
Reboot; verify `feature-stand-manager` registers (primary `flant/infra/review`) and that repo clones. Confirm the agent has `dispatch_workflow` (Plan 1 must be in the running build) — check the repo-tools inventory in its spawn log, or a dry task asking it to list its tools. If `flant/infra/review` won't clone (bot access), rebind to a clonable repo per the note above.

---

## Task 5: Live end-to-end verification (owner-run)

**Files:** none (verification).

> This exercises live Jira/Confluence/GitLab/pipeline — run it against the live instance (like the Phase-1 E2E). No unit tests substitute for it.

- [ ] **Step 1: Pick a safe test Jira ticket** whose feature touches a repo the bot can push to (ideally your sandbox). Confirm it's in the Confluence ownership doc.
- [ ] **Step 2: In Slack, "@Archie implement <KEY>".** Verify the PM: fetches the ticket (Jira MCP), reads Confluence, and **posts the proposed affected repos and waits**.
- [ ] **Step 3: Confirm the repos.** Verify the PM delegates to the right standing agent(s) and/or spawns a repo agent; approve edit mode when asked.
- [ ] **Step 4: Verify each dev agent** opens an MR on `feature/<KEY>` into the repo's default branch (never merged) and reports the URL.
- [ ] **Step 5: Verify the feature-stand-manager** dispatches the review pipeline (`dispatch_workflow` → pipeline URL), the pipeline succeeds, and it returns the stand URL(s).
- [ ] **Step 6: Verify the PM** posts the stand URL(s) + MR links in Slack and adds **one closing Jira comment** (MR + stand URLs), with no status/label change.
- [ ] **Step 7: Record evidence** (task knowledge.log path, MR URLs, pipeline URL, stand URL, Jira comment) — mirror the Phase-1 E2E evidence style.

Failure handling to confirm: if a dev agent or the pipeline fails, the PM relays the failure in Slack and stops (no fake success).

---

## Self-Review
- **Spec coverage:** MCP wiring (T1) → PM orchestration incl. Jira/Confluence + affected-repo confirm + hybrid delegation + feature-stand handoff + closing Jira comment (T2) → standing backend/frontend agents (T3) → feature-stand-manager + repos.yml/review.yml, using `dispatch_workflow` (T4) → live E2E (T5). Matches the design's components + decisions (hybrid, `feature/<KEY>`, closing-comment-only, central werf pipeline, dynamic spawn).
- **Placeholder scan:** none — every file has complete content. `<KEY>` / `{ticket_lower}` are runtime substitutions the agents perform, not plan placeholders.
- **Consistency:** repo ids are GitLab `group/project` everywhere (frontmatter + repos.yml keys match: `walli/sweed/server`, `sd/service/shop-api`, `walli/sweed/web-ui-portal-ci`, `walli/sweed/web-ui-cashier-ci`, `sd/web-ui-shop`, `flant/infra/review`); standing-agent split matches the PM overlay's routing list; `dispatch_workflow` inputs (namespace + `REVIEW_*_BRANCH` + `US_BOT`) match Plan 1's tool + the review pipeline contract.
- **Mechanics verified:** `dispatch_workflow` is a repo tool → feature-stand-manager is a repo agent; agents read `${CLAUDE_PLUGIN_ROOT}/config/*.yml`; PM overlay frontmatter grants `jira`/`confluence` MCP.
- **Flagged for implementation:** MCP transport `http` vs `sse` (verify against `1bf.sweed.tech`); bot clone access to `flant/infra/review` (else rebind the manager); `flant/infra/review` API access for the pipeline dispatch (design Input #3).
