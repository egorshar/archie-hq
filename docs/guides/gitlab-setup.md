# GitLab setup guide

How to point Archie at a self-hosted **GitLab** instance with `REPO_HOST=gitlab`. GitHub remains the default repo host (`REPO_HOST=github` or unset) and nothing here changes that path -- the selection is validated at boot by `assertBackendConfig()`, and any value other than `github`/`gitlab` is rejected.

## What you get

Setting `REPO_HOST=gitlab` swaps the active `RepoHost` implementation to `GitLabHost` (`src/connectors/gitlab/`). Archie then drives the full agent flow against GitLab:

- **Git over HTTPS** -- clone, fetch, commit, and push, authenticated by the host-aware `scripts/git-askpass.sh`.
- **Merge requests** -- create, read, update, comment, and merge (through the agent's repo tools).
- **CI** -- read pipeline status, jobs, and job logs.
- **Reviews** -- synthesized from MR approvals (`approved`) and unresolved reviewer discussions (`changes_requested`), so agents see the same distinct review states as on GitHub.
- **Webhooks** -- MR, note, pipeline, and push events wake the owning task and refresh its Slack CR card.

Everything else -- task orchestration, agent spawning, Slack integration, the PM/specialist loop -- is unchanged; it only ever talks to the `RepoHost` port. Two things are intentionally not wired for GitLab: there is no automatic merge-on-green orchestration (an agent, or a human in GitLab, performs merges), and code-scanning/security alerts are not surfaced (`securityAlerts` is off; there is no vulnerability-API integration).

## 1. Bot user and access token

Create a dedicated bot user in GitLab for Archie to act as -- commits, comments, and MR actions are attributed to it. Then create a **group access token** (preferred; it covers every project under the group) or a **project access token** (for a single repo), with these scopes:

- `api` -- REST API access (MRs, notes, pipelines, approvals).
- `read_repository` -- clone and fetch.
- `write_repository` -- push branches.

The commit author email (`GITLAB_BOT_EMAIL`) should be the token account's verified/commit email (e.g. a `project_*_bot_*@noreply.<host>` address) so pushes satisfy any host push rule that requires it.

## 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `REPO_HOST=gitlab` | yes | Selects `GitLabHost` in `src/system/backends.ts`. |
| `GITLAB_BASE_URL` | yes | Base URL of the instance, e.g. `https://gitlab.internal.example`. Used for REST (`<base>/api/v4/...`) and clone URLs (`<base>/<repo>.git`). |
| `GITLAB_TOKEN` | yes | The bot's group/project access token. |
| `GITLAB_WEBHOOK_SECRET` | yes | Shared secret GitLab sends back as `X-Gitlab-Token`; deliveries whose token doesn't match are rejected. |
| `GITLAB_BOT_USERNAME` | recommended | The bot's GitLab username. Two jobs: discarding Archie's own webhook events (self-event filtering), and the `@mention` on merge-request attribution. Unset, MRs still open — they just name nobody. |
| `GITLAB_BOT_NAME` / `GITLAB_BOT_EMAIL` | recommended | Git commit author identity for Archie's commits. When unset, git falls back to its own configured identity. |
| `GIT_ASKPASS=/app/scripts/git-askpass.sh` | yes (set in Docker) | The host-aware credential helper for clone/fetch/push. The Docker images set this and mark the script executable. |
| `NODE_EXTRA_CA_CERTS` | if applicable | Path to an internal CA bundle, when the instance's TLS certificate is signed by an internal CA. |

`GITLAB_BASE_URL`, `GITLAB_TOKEN`, and `GITLAB_WEBHOOK_SECRET` are all required when `REPO_HOST=gitlab`; boot fails fast naming whichever are missing. See `.env.example` for a copy-paste block.

The `ARCHIE_GITHUB_*` variables are GitHub-only and are ignored here; `GITLAB_BOT_USERNAME` is their counterpart.

### Merge-request attribution

Every MR Archie opens carries one stamped line above the description saying who opened it and for whom — the human is whoever approved edit mode, which is also who the commits are authored as, so the MR names exactly whoever `git blame` will. It is composed by Archie rather than left to the model, so it cannot be reworded or dropped by a later `update_pr`, and re-stamping replaces the previous line rather than stacking a second one.

Two GitLab-specific notes. The `@mention` comes from `GITLAB_BOT_USERNAME`; without it the line is omitted entirely rather than naming an invented handle. And the line is rendered as a labelled blockquote (`> **Note:** …`) rather than the GitHub Alert (`> [!NOTE]`) used on GitHub, because alerts are a GitHub-flavour extension that degrades to an unlabelled quote where it is not implemented.

## 3. Git authentication

Clone/fetch/push credentials come from `scripts/git-askpass.sh` (wired via `GIT_ASKPASS`). With `REPO_HOST=gitlab` it returns username `oauth2` and password `$GITLAB_TOKEN`; the script inherits both variables from the app process environment, so no per-repo credential configuration is needed. The clone URL is `<GITLAB_BASE_URL>/<repo>.git`, where `<repo>` is `group/project`.

## 4. Webhook configuration

Add a project (or group) webhook in GitLab pointing at Archie:

- **URL:** `https://<archie-host>/webhooks/gitlab`
- **Secret token:** the same value as `GITLAB_WEBHOOK_SECRET`
- **Trigger events:** Merge request events, Comments (notes), Push events, Pipeline events

There is no polling fallback -- GitLab must be able to deliver these to Archie.

## 5. Network reachability

Self-hosted GitLab instances are often reachable only from inside a corporate VPN. Confirm both directions before going live: Archie's host must reach the GitLab instance (REST + clone/push), and the GitLab instance must reach Archie's webhook endpoint (event delivery).

## 6. Protected branches

Configure the target project's default branch as protected, with required approvals, as a host-side backstop independent of Archie. GitLab's native "merge when pipeline succeeds" (`nativeAutoMerge`) is not used.

## 7. Verify

- **Boot + health.** Start Archie with the variables above. The boot log prints `Backends: repoHost=gitlab`, and `GET /health` reports `backends.repoHost=gitlab`.
- **Git round-trip.** Have an agent clone a real project, commit, and push a branch -- this exercises `git-askpass.sh`'s GitLab path end to end.
- **MR + review.** Open an MR, leave a reviewer discussion unresolved, and confirm `get_pr_reviews` surfaces it as `changes_requested`; approve the MR and confirm it reads as `approved`.
- **CI wake-up.** Push a commit that fails the pipeline and confirm the pipeline webhook wakes the owning task.
