# GitLab operator setup guide

This guide covers running Archie against a self-hosted **GitLab Premium** instance via `REPO_HOST=gitlab`. GitHub remains the default repo host (`REPO_HOST=github` or unset) and nothing below changes that path. Everything here is additive: unsupported values for `REPO_HOST` are still rejected at boot by `assertBackendConfig()`.

## Overview

Setting `REPO_HOST=gitlab` swaps the active `RepoHost` implementation from `GitHubHost` to `GitLabHost` (`src/connectors/gitlab/`). Archie talks to GitLab exclusively through its REST v4 API (`PRIVATE-TOKEN` auth), receives webhooks at a GitLab-specific endpoint, and clones/pushes over HTTPS using a GitLab-flavored `git-askpass.sh` credential path. The rest of the system — task orchestration, agent spawning, Slack integration, the PM/specialist agent loop — is unaffected; it only ever talks to the `RepoHost` port.

## Bot user and access token

Create a dedicated bot user in GitLab for Archie to act as (comments, commits, and MR actions will be attributed to it). Then create a **group access token** (preferred, so it covers every project under the group) or a **project access token** if Archie only needs to operate on a single repo, with these scopes:

- `api` — full REST API access (MRs, notes, pipelines, approvals).
- `read_repository` — clone and fetch.
- `write_repository` — push branches.

Set the following environment variables from that token and bot user:

- `GITLAB_TOKEN` — the access token value.
- `GITLAB_BOT_USERNAME` — the bot user's GitLab username, used to detect and skip Archie's own webhook events (self-event filtering).
- `GITLAB_BOT_NAME` / `GITLAB_BOT_EMAIL` (optional) — sets the git commit author identity for Archie's commits; when unset, `botIdentity()` returns `null` and git falls back to its own configured identity.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `REPO_HOST=gitlab` | Selects `GitLabHost` at `src/system/backends.ts`. |
| `GITLAB_BASE_URL` | Base URL of the GitLab instance, e.g. `https://gitlab.internal.example.com`. Used for both REST calls (`<base>/api/v4/...`) and clone URLs (`<base>/<repo>.git`). |
| `GITLAB_TOKEN` | The bot's group/project access token (see above). |
| `GITLAB_WEBHOOK_SECRET` | Shared secret GitLab sends back as `X-Gitlab-Token`; Archie rejects any webhook delivery whose token doesn't match. |
| `GIT_ASKPASS=/app/scripts/git-askpass.sh` | Enables the host-aware credential helper for clone/fetch/push (see below). |
| `NODE_EXTRA_CA_CERTS` | Path to an internal CA bundle, needed when the GitLab instance's TLS certificate is signed by an internal CA rather than a public one. |

`GITLAB_BASE_URL`, `GITLAB_TOKEN`, and `GITLAB_WEBHOOK_SECRET` are all required when `REPO_HOST=gitlab`; boot logs a warning and skips mounting the GitLab webhook if the secret is missing.

**VPN note:** self-hosted GitLab instances are frequently reachable only from inside a corporate VPN. Archie's own host must be VPN-reachable to the GitLab instance (for REST calls and clone/push), and the GitLab instance must be able to reach Archie's webhook endpoint (for event delivery) — confirm both directions before going live, since this can't be verified from CI.

## Webhook configuration

Add a project (or group) webhook in GitLab pointing at Archie:

- **URL:** `https://<archie-host>/webhooks/gitlab`
- **Secret token:** the same value as `GITLAB_WEBHOOK_SECRET`
- **Trigger events:**
  - Merge request events
  - Comments (notes)
  - Push events
  - Pipeline events

GitLab must be able to deliver these to Archie from inside the VPN; there is no polling fallback.

## Tier notes (Premium)

This setup targets **GitLab Premium**, not Ultimate:

- Approval rules and the `approved` webhook event are available on Premium — approval-driven merge checks work end-to-end.
- The vulnerability/security API is **Ultimate-only**. On Premium, `securityAlerts` stays `false`, and the `list_code_scanning_alerts` / `get_code_scanning_alert` tool handlers short-circuit with "not available on this repo host" rather than calling an endpoint that doesn't exist on this license. This path is dormant on Premium — see the E2E checklist below for what to skip.
- Reviews are synthesized rather than native: GitLab has approvals and discussion notes, not GitHub-style distinct `approved`/`changes_requested` review states (`reviewStates=false`). Archie derives `changes_requested` from unresolved reviewer discussions and `approved` from the approvals API (design decision D2).

## Protected branches and merge settings

Configure the target project's default branch as protected, with required approvals, as a host-side backstop independent of Archie's own orchestration. Archie orchestrates merges itself by default (mirroring the GitHub path) even though GitLab exposes a native "merge when pipeline succeeds" option (`nativeAutoMerge=true` in the capability matrix) — that native option is not used by default.

## Capability probe

At boot, once `REPO_HOST=gitlab` is resolved, Archie calls `GET /license` against the GitLab instance (`GitLabHost.probeCapabilities()`). On a Premium instance this returns a non-Ultimate plan, so Archie logs the detected plan and leaves `securityAlerts=false`. If the `/license` endpoint is unreachable or restricted (e.g. the token lacks admin scope), the probe fails closed and capabilities stay at their least-capable defaults — this is expected and safe on Premium.

## Live-instance E2E checklist

Archie's CI cannot reach a VPN-internal GitLab instance, so this checklist must be run by hand against the real target instance before/after a deploy. Each item names what it verifies and why it can't be covered by unit tests alone.

- **Boot + `/health`.** Start Archie with `REPO_HOST=gitlab` and the env vars above set. Confirm the boot log prints the resolved capability matrix (`securityAlerts=false` on Premium) and that `GET /health` reports `backends.repoHost=gitlab`.
- **Clone, fetch, and push.** Have an agent clone a real GitLab project (through the base cache and a shared clone), fetch, commit, and **push** a branch. This is the critical path for `git-askpass.sh`'s GitLab branch (`oauth2` username, `$GITLAB_TOKEN` password) — note that `scripts/git-askpass.sh` is tracked in git with mode `100644` (not executable) and only becomes executable via `chmod +x` in the Docker build (`Dockerfile.dev`/`Dockerfile.prod`); confirm on the live instance that the script is actually invoked and the push succeeds, not just that clone/fetch work over an already-cached credential.
- **MR lifecycle including approval.** Create an MR, have a reviewer comment (verify the review-comment wake-up reaches the PM agent), then **approve** the MR and confirm the Premium `approved` webhook event triggers Archie's merge check.
- **Synthesized reviews (D2).** Leave a reviewer discussion unresolved and confirm `get_pr_reviews` surfaces it as `changes_requested`; resolve the discussion and confirm it clears.
- **CI wake-up and check-run lookup.** Push a commit that makes the pipeline fail and confirm it wakes the PM (`existing_task` routing via the pipeline webhook). Then call `get_check_run` with both a `/-/jobs/<id>` URL and a `/-/pipelines/<id>` URL from the failing MR and confirm each returns the corresponding job or pipeline with the failing job's log tail.
- **Positioned review comment.** Exercise `addReviewComment` against a real MR diff — this resolves the `// E2E-VERIFY` in `src/connectors/gitlab/client.ts` on the diff-note `position` payload shape (`position_type: 'text'`, `new_path`, `new_line`, `base_sha`/`head_sha`/`start_sha` from the MR's `diff_refs`), which can't be validated against a mocked API.
- **Conflict path.** Create a dirty MR (push conflicting changes so GitLab reports `detailed_merge_status=conflict`) and confirm Archie maps it to `dirty` and notifies the PM rather than attempting a merge.
- **N/A on Premium: vulnerabilities / code scanning.** The vulnerability-API-backed code-scanning path is Ultimate-only and is expected to stay short-circuited ("not available on this repo host") on this Premium instance — skip this item unless the instance is upgraded to Ultimate.
