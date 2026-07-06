# Design — Jira→dev→feature-stand flow (multi-agent, Archie-native)

> Brainstorming output (design doc). The task-by-task implementation plan is produced separately via writing-plans. Context: replaces the single-agent `universal-soldier` opencode skill with Archie's multi-agent, user-initiated flow, reusing its concrete mechanics (Jira MCP, central werf review pipeline, repos config, MR-per-repo). Builds on the Phase-1 GitLab repo host.

## Goal
A user asks Archie in Slack to implement a Jira feature; Archie's PM pulls the ticket context, uses Confluence to decide which repos are affected, delegates implementation to developer agents (one MR per repo, never merged), then has a feature-stand-manager deploy a feature stand via the central review pipeline, and reports the stand + MR links back in Slack for the user to test.

## Scope: two repos, one small core seam
- **`archie-plugins`** (the plugins repo, `git@gitlab.walli.com:e.sharapov/archie-plugins.git`) — all agents + prompts + config + MCP wiring. The bulk of the work.
- **`archie-hq` core** — one small, generic addition: `RepoHost.dispatchWorkflow()` + a `dispatch_workflow` MCP tool (GitLab impl + capability). This is the only non-plugin piece; it exists because triggering a CI run must happen in the Archie process (which holds the token) — the same in-process pattern every existing repo tool uses, so no secret ever reaches an agent.

## End-to-end flow
1. **User (Slack):** "@Archie implement SWEED-123".
2. **PM** → Jira MCP `get-issue(SWEED-123)` → summary, description, acceptance criteria, story points, labels.
3. **PM** → Confluence MCP → reads the ownership doc (see Inputs) → proposes the **affected repos** with each repo's human "details".
4. **PM confirms affected repos with the user in Slack** ("I'll touch `web-ui-portal-ci` + `server` — proceed?") before delegating. Cheap guard against wrong-repo work.
5. **PM delegates per repo (hybrid):**
   - Repo covered by a **standing domain agent** (backend/frontend) → delegate to it.
   - Otherwise → PM `spawn_repo_agent` on-demand, bound to that repo, passing the ticket + Confluence details + `repos.yml` entry as the brief.
6. **Developer agents:** work on branch **`feature/<KEY>`** (e.g. `feature/SWEED-123`), implement to the acceptance criteria, push, and **open one MR per repo into that repo's `target_branch` (never merge)**. Report the MR URL back to the PM.
7. **PM → feature-stand-manager:** hands off the ticket key + the set of affected repos (with their `review_branch_var`s) + the branch.
8. **feature-stand-manager** computes the namespace from `review.namespace_template`, decides new-vs-existing against `review.existing_namespaces_file`, and calls **`dispatch_workflow("flant/infra/review", "ci-bot/us-trigger", { <WERF_NEW|EXISTED>_NAMESPACE, <each repo's review_branch_var>=feature/<KEY>, US_BOT: "true" })`**, then watches the returned pipeline to success and derives the **stand URL(s)** from each affected repo's `stand_url` template.
9. **PM → Slack:** posts the stand URL(s) + MR link(s). **Jira write-back:** one closing comment on the ticket (MR + stand URLs) — no status transition or label change for now. User tests.

Failure handling: any dev agent that can't complete, or a pipeline that fails, reports back to the PM; the PM posts the failure (what failed + links) to Slack and stops — it does not fake success. (No autonomous label state machine; interactive only.)

## Components — `archie-plugins`

### `pm/agents/pm.md` (overlay)
Standing context appended to the PM's system prompt. Covers:
- The flow above, in order.
- **Jira:** use only the `jira` MCP tools (`search`, `get-issue`, `update-issue`, `add-comment`, `transition-issue`, `get-transitions`); never call Jira REST; ignore own `is_bot:true` comments.
- **Confluence:** use the `confluence` MCP to read the ownership doc; map the feature → affected repos using the ticket text + each repo's description; when unsure, ask the user (Slack) rather than guess.
- **Affected-repo confirmation** step (Slack) before delegating.
- **Delegation rules:** standing agent vs `spawn_repo_agent` (hybrid); pass the `repos.yml` entry + Confluence details as the brief; instruct the branch name `feature/<KEY>`.
- **Feature-stand handoff** to `feature-stand-manager` after all MRs are open.
- **Jira write-back:** a single closing comment (`add-comment`) with MR + stand URLs; no status transition or label change.
- **Slack** is native (Archie comms tools) — no bash/curl.

### Standing dev agents (`backend/agents/backend.md`, `frontend/agents/frontend.md`)
Repo agents (`metadata.archie.repos`) bound to the common repos from `repos.yml`:
- `backend` → `server`, `shop-api`.
- `frontend` → `web-ui-portal-ci`, `web-ui-cashier-ci`, `web-ui-shop`.
Behavior: investigate read-only, implement after edit-mode approval, keep changes minimal/scoped to the acceptance criteria, branch `feature/<KEY>`, push, open MR (never merge), report the MR URL. (Dynamically-spawned agents for any other repo get the same generic developer behavior via the spawn brief.)

### `feature-stand/agents/feature-stand-manager.md`
A repo agent (bound to the review-pipeline repo, `flant/infra/review`) responsible only for the stand:
- Read `config/review.yml` + the affected repos' `repos.yml` entries.
- Compute namespace from `namespace_template` (`feature-{ticket_lower}`; must match `^feature-[a-zA-Z-]{1,10}-[0-9]{1,8}$`).
- New vs existing: read `existing_namespaces_file` (`vars/namespace-options.yml@ci-bot/variables`); pass `WERF_EXISTED_NAMESPACE` if listed, else `WERF_NEW_NAMESPACE`.
- Call `dispatch_workflow` with `ref=ci-bot/us-trigger`, `inputs = { <namespace var>, US_BOT: "true", <review_branch_var>=feature/<KEY> for each affected repo }`.
- Watch the returned pipeline to success (via `get_workflow_run` / `get_pr_checks`), then derive stand URL(s) from each affected repo's `stand_url` template (`{ticket}`→`SWEED-123`, `{ticket_lower}`→`sweed-123`); repos without `stand_url` deploy into the same namespace but report no URL.
- Report stand URL(s) + pipeline URL to the PM; on failure, report what failed.

### `config/repos.yml`
Operational per-repo config (versioned; **CI-generatable**). Schema per entry: `clone`, `target_branch`, `review_branch_var`, optional `stand_url`, and `owner_agent` (which standing agent covers it, or empty → dynamic spawn). Seeded from the existing universal-soldier `repos.yml`:
- `web-ui-portal-ci` — master, `REVIEW_WEB_UI_PORTAL_CI_BRANCH`, `https://feature-{ticket_lower}.sweedpos.com`, frontend.
- `server` — master, `REVIEW_SERVER_BRANCH`, (no stand_url), backend.
- `shop-api` — master, `REVIEW_SHOP_API_BRANCH`, (no stand_url), backend.
- `web-ui-cashier-ci` — master, `REVIEW_WEB_UI_CASHIER_CI_BRANCH`, `https://cashier-feature-{ticket_lower}.sweedpos.com`, frontend.
- `web-ui-shop` — master, `REVIEW_WEB_UI_SHOP_BRANCH`, `https://web-ui-feature-{ticket_lower}.sweedpos.com`, frontend.

### `config/review.yml`
Central pipeline config (from universal-soldier `config.yml` `review` block): `project: flant/infra/review` (id 290), `ref: ci-bot/us-trigger`, `namespace_template: feature-{ticket_lower}`, `existing_namespaces_file: vars/namespace-options.yml@ci-bot/variables`.

### `.mcp.json`
Remote MCP servers (Archie substitutes `${MCP_*}` and passes the config to the SDK):
```json
{
  "mcpServers": {
    "jira": {
      "type": "http",
      "url": "https://1bf.sweed.tech/mcp/a/jira",
      "headers": { "Authorization": "Bearer ${MCP_JIRA_TOKEN}" },
      "description": "Jira (PII-filtered, project-allowlisted): search, get-issue, update-issue, add-comment, transition-issue, get-transitions."
    },
    "confluence": {
      "type": "http",
      "url": "https://1bf.sweed.tech/mcp/a/confluence",
      "headers": { "Authorization": "Bearer ${MCP_CONFLUENCE_TOKEN}" },
      "description": "Confluence: read the Repositories / Code ownership doc to map a feature to affected repos."
    }
  }
}
```
`jira` + `confluence` are referenced in the PM's frontmatter `mcpServers`. (`type: http` is the SDK's streamable-HTTP transport; fall back to `sse` if the server speaks SSE — verify at wiring time.)

## Core addition — `archie-hq`

### `RepoHost.dispatchWorkflow` + capability
Canonical (GitHub-semantic) naming, consistent with the existing `WorkflowRunReport` / `getWorkflowRunById` / `workflow_run` vocabulary. GitLab maps its pipeline API into it.

```ts
// ports/repo-host.ts
dispatchWorkflow(repo: string, ref: string, opts?: { workflow?: string; inputs?: Record<string, string> }): Promise<WorkflowDispatchResult>;
// ports/repo-host-types.ts
export interface WorkflowDispatchResult { id: number | string | null; url: string | null; }
```
Capability flag `workflowDispatch: boolean` in `RepoHostCapabilities` (GitLab: `true`; GitHub: `true` where Actions is used, else the tool short-circuits like the security tools do).

Mapping:
| | GitLab impl | GitHub impl |
|---|---|---|
| endpoint | `POST /projects/:id/pipeline` | `POST /repos/{o}/{r}/actions/workflows/{workflow}/dispatches` |
| `ref` | `ref` | `ref` |
| `inputs` | → `variables` (array form `[{key,value}]`) | → `inputs` |
| returns | pipeline `{ id, web_url }` | 204 (no body) → `{ id: null, url: null }` |

GitLab detail (from universal-soldier): variables must be sent as a JSON **array** (`{"ref":…, "variables":[{"key":…,"value":…}]}`) with `Content-Type: application/json`, else GitLab ignores them / 415s. `glRequest` already sets JSON content-type.

### `dispatch_workflow` MCP tool
A generic repo tool (same family as `create_pull_request`), registered on the repo-tools MCP server, gated on `capabilities().workflowDispatch`. Args: `{ repo, ref, inputs?: Record<string,string>, workflow? }`. Calls `getRepoHost().dispatchWorkflow(...)` in-process (token never reaches the agent). Returns the pipeline/run id + URL. Available to repo agents (so the feature-stand-manager can call it).

## Inputs required (env + facts)
- `MCP_JIRA_TOKEN`, `MCP_CONFLUENCE_TOKEN` — bearer tokens for the remote MCP servers (added to Archie's env; `${MCP_*}` substitution).
- `GITLAB_TOKEN` (Archie's repo-host token) must have **API access to `flant/infra/review` (project 290)** to dispatch its pipeline. If the deployment's bot token can't reach project 290, the bot needs membership/access there (webhook coverage ≠ access; same lesson as before).
- Confluence ownership doc: `https://sweed.atlassian.net/wiki/spaces/TD/pages/18251913/Repositories+Code+ownership` (space `TD`, page id `18251913`) — the PM reads it via the Confluence MCP.
- The `flant/infra/review` pipeline contract (namespace vars, `US_BOT`, `REVIEW_*_BRANCH`) is as documented in universal-soldier Step 7.

## Decisions (locked)
- Multi-agent, **user-initiated** (name a ticket: "implement SWEED-123"); not the autonomous scheduled tick.
- Dev agents: **hybrid** (standing backend/frontend + dynamic `spawn_repo_agent`).
- Repo operational fields: **`config/repos.yml`** in the plugins repo (CI-generatable); Confluence is human discovery.
- Jira write-back: **closing comment only** (`add-comment` with MR + stand URLs); no status transition or label change.
- Feature stand: **central werf review pipeline** via the generic `dispatch_workflow` tool.
- Trigger seam: **`dispatch_workflow` typed tool + `RepoHost.dispatchWorkflow`** (canonical naming; no secret in agents; not a bespoke deploy tool).
- Branch: **`feature/<KEY>`**.
- Affected-repo **confirmation gate** in Slack before delegating.

## Out of scope
- Autonomous scheduling / per-tick loop, the `us-*` label state machine, polling cadence (universal-soldier's headless model) — this is interactive.
- Auto-merge (never merge; MRs are for human review).
- The CI script that *generates* `repos.yml` (treated as an input; `repos.yml` is seeded manually from the existing one for now).
- opencode runtime (Phase 2), unrelated.

## Testing
- **Unit (`archie-hq`):** `dispatchWorkflow` GitLab mapping (mock fetch → assert `POST /projects/:id/pipeline` with the array-form `variables` + JSON content-type; returns `{id,url}`); `dispatch_workflow` tool capability-gate (short-circuits when `workflowDispatch` false); capability descriptors.
- **Config parse:** `repos.yml` / `review.yml` load + shape.
- **E2E (manual, live):** a real Jira ticket → PM Confluence mapping → confirm repos → dev MR(s) → feature-stand-manager `dispatch_workflow` → pipeline success → stand URL(s) in Slack → closing Jira comment. (Owner-run against the live instance, like the Phase-1 E2E.)
