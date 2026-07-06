# Phase 1 · GitLab Host — Plan 4: Clone/Askpass, Log Neutrality, Docs & Acceptance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-06-phase-1-gitlab-host-design.md` — Phase 1 design.
> - `docs/architecture/backends.md` — the seam (this plan updates it).
> - `src/connectors/github/repo-clone.ts` (`githubRepoToUrl`, `setupSharedClone`), `scripts/git-askpass.sh` + `scripts/github-token.ts` (the auth flow), `src/tasks/persistence.ts` (`appendGitHubEvent`), `src/system/workdir.ts` (startup repo clone).

**Goal:** Finish Phase 1 — make repo cloning/auth host-aware for GitLab (wire `askpassToken()`, closing B5), neutralize the `github:` log prefix so GitLab events render correctly, document GitLab operations (`gitlab-setup.md`), update `backends.md` to promote GitLab to a real second host, and land the acceptance + live-instance E2E checklist. GitHub stays byte-for-byte unchanged.

**Target tier: GitLab Premium** (resolved). Approvals API + `approved` webhook are available (D2 `approved`→merge_check path is live). The vulnerability API is **Ultimate-only**, so `securityAlerts` stays `false` on this instance and the security tools stay short-circuited — the Plan-2 vuln-API E2E-VERIFY items are **N/A for this deployment** (only relevant if upgraded to Ultimate).

**Architecture:** A host-neutral `repoCloneUrl(repo)` (reads `REPO_HOST`/`GITLAB_BASE_URL` env directly, no backend-resolver import → no cycle) replaces the two hardcoded `githubRepoToUrl` runtime call sites. `git-askpass.sh` branches on `REPO_HOST` (GitLab → `oauth2` + `GITLAB_TOKEN`; GitHub → `x-access-token` + generated App token). The log-destination prefix derives from `REPO_HOST`.

**Tech Stack:** Node ≥20 (ESM, `.js` specifiers), TypeScript, Vitest ^4, bash (askpass), git CLI.

## Global Constraints

- **Additive / zero behavior change (P1).** With `REPO_HOST` unset/`=github`: clone URLs, askpass output, log prefixes, and behavior are IDENTICAL to before. Full suite passes unmodified; existing tests not edited. Default `REPO_HOST=github`.
- **No import cycles.** The host-neutral clone-URL helper reads env directly; it must NOT import `system/backends.ts` or a connector `client.ts` (both sit above `repo-clone.ts`/`workdir.ts` in the graph).
- **Vendor isolation.** No GitLab HTTP outside `src/connectors/gitlab/` (the acceptance grep stays clean).
- **Logging.** Never `console.*`; use `logger`.
- **Docs are prose:** one line per paragraph/bullet; only fenced code spans fixed width.
- **Commits.** Atomic, one logical change per task; commit at task end (authorized; do not push).

## File Structure

New files:
- `src/connectors/shared/repo-url.ts` — `repoCloneUrl(repo)` + `repoEventPrefix()` (host-neutral, env-driven).
- `src/connectors/shared/__tests__/repo-url.test.ts`.
- `docs/guides/gitlab-setup.md` — operator guide (T4).

Modified files:
- `src/tasks/persistence.ts` — `appendGitHubEvent` destination uses `repoEventPrefix()` (T1).
- `src/connectors/github/repo-clone.ts` — `setupSharedClone`/`ensureBaseCache` use `repoCloneUrl` (T2).
- `src/system/workdir.ts` — startup clone uses `repoCloneUrl` (T2).
- `scripts/git-askpass.sh` — host-aware credentials (T3).
- `.env.example` — GitLab vars (T3/T4).
- `docs/architecture/backends.md` — GitLab promoted to a real host (T4).

## Task order

T1 (log prefix) → T2 (clone URL) → T3 (askpass) → T4 (docs + acceptance).

---

## Task 1: Neutralize the log-destination prefix

**Files:**
- Create: `src/connectors/shared/repo-url.ts` (add `repoEventPrefix`)
- Create: `src/connectors/shared/__tests__/repo-url.test.ts`
- Modify: `src/tasks/persistence.ts` (`appendGitHubEvent`)

**Interfaces:**
- Produces: `repoEventPrefix(): 'github' | 'gitlab'` — derived from `REPO_HOST` env (default `github`). `appendGitHubEvent` uses it for the destination prefix. Consumed by the knowledge log / CLI rendering.

> The `github:` prefix in `appendGitHubEvent` (`persistence.ts:482`) is PM-facing — GitLab events currently render as `github:group/project/MR !5`. Derive the prefix from `REPO_HOST` so GitLab events read `gitlab:group/project/MR !5`. GitHub output is unchanged when `REPO_HOST` is unset/`github`.

- [ ] **Step 1: Check for consumers that parse the `github:` prefix.**

Run: `grep -rn "github:" src --include="*.ts" | grep -v "https://github.com" | grep -v "// " | grep -iv "githubRepo\|github: " | head -30`
Also: `grep -rn "startsWith('github:')\|split(':')\|'github:'" src --include="*.ts"`
Expected: the only WRITER is `persistence.ts:482`. If a reader hardcodes `github:` parsing, note it — the neutral prefix must not break it (rendering that just displays the string is fine). Record findings; proceed (the destination is a display string).

- [ ] **Step 2: Write the failing test.** Create `src/connectors/shared/__tests__/repo-url.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { repoEventPrefix } from '../repo-url.js';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('repoEventPrefix', () => {
  it('defaults to github when REPO_HOST is unset', () => {
    delete process.env.REPO_HOST;
    expect(repoEventPrefix()).toBe('github');
  });
  it('returns github for REPO_HOST=github', () => {
    process.env.REPO_HOST = 'github';
    expect(repoEventPrefix()).toBe('github');
  });
  it('returns gitlab for REPO_HOST=gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(repoEventPrefix()).toBe('gitlab');
  });
  it('normalizes case/whitespace', () => {
    process.env.REPO_HOST = '  GitLab ';
    expect(repoEventPrefix()).toBe('gitlab');
  });
});
```

- [ ] **Step 3: Run, verify RED.**

Run: `npx vitest run src/connectors/shared/__tests__/repo-url.test.ts`
Expected: FAIL — cannot find module `../repo-url.js`.

- [ ] **Step 4: Create `src/connectors/shared/repo-url.ts`.**

```ts
/**
 * Host-neutral repo URL + label helpers. Reads REPO_HOST / GITLAB_BASE_URL from
 * the environment directly (NOT via system/backends.ts) so low-level modules
 * (repo-clone, workdir, persistence) can use it without an import cycle. Mirrors
 * each host's cloneUrl() logic. `repoCloneUrl` is added in Task 2.
 */

export function repoHostKind(): 'github' | 'gitlab' {
  return (process.env.REPO_HOST ?? 'github').trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
}

/** Prefix for knowledge-log event destinations, e.g. `github:` / `gitlab:`. */
export function repoEventPrefix(): 'github' | 'gitlab' {
  return repoHostKind();
}
```

- [ ] **Step 5: Use it in `appendGitHubEvent`.** In `src/tasks/persistence.ts`, add the import:

```ts
import { repoEventPrefix } from '../connectors/shared/repo-url.js';
```
and change (line ~482):
```ts
const destination = `github:${githubRepo}/${event.destination}`;
```
to:
```ts
const destination = `${repoEventPrefix()}:${githubRepo}/${event.destination}`;
```

- [ ] **Step 6: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/connectors/shared/__tests__/repo-url.test.ts && npm test`
Expected: PASS. Default (`REPO_HOST` unset) keeps the `github:` prefix, so existing tests are unaffected.

- [ ] **Step 7: Commit.**

```bash
git add src/connectors/shared/repo-url.ts src/connectors/shared/__tests__/repo-url.test.ts src/tasks/persistence.ts
git commit -m "fix(events): derive knowledge-log destination prefix from REPO_HOST (gitlab: for GitLab)"
```

---

## Task 2: Host-aware clone URL

**Files:**
- Modify: `src/connectors/shared/repo-url.ts` (add `repoCloneUrl`)
- Modify: `src/connectors/shared/__tests__/repo-url.test.ts`
- Modify: `src/connectors/github/repo-clone.ts` (`ensureBaseCache`, `setupSharedClone`)
- Modify: `src/system/workdir.ts` (startup clone)

**Interfaces:**
- Produces: `repoCloneUrl(repo): string` — `https://github.com/<repo>.git` for github; `<GITLAB_BASE_URL>/<repo>.git` for gitlab. Replaces the hardcoded `githubRepoToUrl` at the two runtime clone sites.

> `githubRepoToUrl` stays (GitHub's `client.cloneUrl()` uses it, and it is the github branch of `repoCloneUrl`). The runtime clone paths (`setupSharedClone`, `ensureBaseCache`, `workdir` startup clone) switch to `repoCloneUrl` so GitLab repos clone from the GitLab host instead of github.com.

- [ ] **Step 1: Write the failing tests.** Append to `repo-url.test.ts`:

```ts
import { repoCloneUrl } from '../repo-url.js';

describe('repoCloneUrl', () => {
  it('builds a github.com URL by default', () => {
    delete process.env.REPO_HOST;
    expect(repoCloneUrl('org/backend')).toBe('https://github.com/org/backend.git');
  });
  it('builds a GitLab URL from GITLAB_BASE_URL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    expect(repoCloneUrl('grp/proj')).toBe('https://gl.example/grp/proj.git');
  });
  it('strips a trailing slash from GITLAB_BASE_URL', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example/';
    expect(repoCloneUrl('grp/proj')).toBe('https://gl.example/grp/proj.git');
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/shared/__tests__/repo-url.test.ts -t repoCloneUrl`
Expected: FAIL — `repoCloneUrl` is not exported.

- [ ] **Step 3: Add `repoCloneUrl` to `src/connectors/shared/repo-url.ts`.**

```ts
export function repoCloneUrl(repo: string): string {
  if (repoHostKind() === 'gitlab') {
    const base = (process.env.GITLAB_BASE_URL ?? '').replace(/\/+$/, '');
    return `${base}/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}
```

- [ ] **Step 4: Route the runtime clone sites through it.**

In `src/connectors/github/repo-clone.ts`, add the import:
```ts
import { repoCloneUrl } from '../shared/repo-url.js';
```
Replace the URL construction in `ensureBaseCache` (line ~106) `const url = githubRepoToUrl(githubRepo);` → `const url = repoCloneUrl(githubRepo);` and in `setupSharedClone` (line ~139) `const githubUrl = githubRepo ? githubRepoToUrl(githubRepo) : undefined;` → `const githubUrl = githubRepo ? repoCloneUrl(githubRepo) : undefined;`. Leave the `githubRepoToUrl` export in place (still used by `client.cloneUrl()`).

In `src/system/workdir.ts` (line ~128) replace `const repoUrl = githubRepoToUrl(github);` → `const repoUrl = repoCloneUrl(github);` and update its import to also pull `repoCloneUrl` from `../connectors/shared/repo-url.js` (keep `githubRepoToUrl` import only if still referenced elsewhere in the file; otherwise replace it).

- [ ] **Step 5: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS. Default config still builds `https://github.com/...` URLs (byte-identical); GitLab config builds GitLab URLs.

- [ ] **Step 6: Commit.**

```bash
git add src/connectors/shared/repo-url.ts src/connectors/shared/__tests__/repo-url.test.ts src/connectors/github/repo-clone.ts src/system/workdir.ts
git commit -m "feat(clone): host-aware repoCloneUrl for base cache, shared clones, and startup clone"
```

---

## Task 3: Host-aware git-askpass (wire `askpassToken`, closes B5)

**Files:**
- Modify: `scripts/git-askpass.sh`
- Modify: `.env.example` (document GitLab auth vars)

**Interfaces:**
- Produces: `git-askpass.sh` returns GitLab credentials (`oauth2` + `$GITLAB_TOKEN`) when `REPO_HOST=gitlab`, GitHub credentials otherwise. GIT_ASKPASS remains operator-configured to this script.

> The auth'd git operations Archie performs (startup clone in `workdir.ts`, `setupSharedClone`/`fetchOrigin`) run in the **main process**, which has the full env (`REPO_HOST`, `GITLAB_TOKEN`, `GIT_ASKPASS`). GitLab accepts a token as the password with username `oauth2` (project/group access token). No token generation is needed (unlike GitHub App tokens). **E2E-VERIFY:** end-to-end clone + fetch + push against the live Premium instance (agent push auth path is validated there — see the E2E checklist in T4).

- [ ] **Step 1: Make `scripts/git-askpass.sh` host-aware.** Replace its body with:

```bash
#!/bin/bash
# GIT_ASKPASS helper. Returns credentials for the active repo host (REPO_HOST).
#
# GitHub (default): username "x-access-token", password = GitHub App installation
#   token (generated by github-token.js).
# GitLab: username "oauth2", password = $GITLAB_TOKEN (group/project access token).

PROMPT="$1"
REPO_HOST="${REPO_HOST:-github}"

if [ "$REPO_HOST" = "gitlab" ]; then
  case "$PROMPT" in
    Username*) echo "oauth2" ;;
    Password*) echo "$GITLAB_TOKEN" ;;
  esac
else
  case "$PROMPT" in
    Username*)
      echo "x-access-token"
      ;;
    Password*)
      if [ -f /app/dist/scripts/github-token.js ]; then
        node /app/dist/scripts/github-token.js
      else
        npx tsx /app/scripts/github-token.ts
      fi
      ;;
  esac
fi
```

- [ ] **Step 2: Document the auth vars in `.env.example`.** Add (near any existing `GITHUB_*` block, or create a repo-host section):

```bash
# --- Repo host selection ---
# REPO_HOST=gitlab
# GITLAB_BASE_URL=https://gitlab.internal.example
# GITLAB_TOKEN=glpat-...            # group/project access token: api, read_repository, write_repository
# GITLAB_WEBHOOK_SECRET=...          # X-Gitlab-Token value
# GITLAB_BOT_USERNAME=archie-bot     # bot username, for webhook self-event filtering
# GITLAB_BOT_NAME="Archie"           # git commit author name (optional)
# GITLAB_BOT_EMAIL=archie@example.com
# GIT_ASKPASS=/app/scripts/git-askpass.sh   # same script for both hosts (host-aware)
# NODE_EXTRA_CA_CERTS=/app/certs/internal-ca.pem   # if GitLab uses an internal CA
```

- [ ] **Step 3: Manual verification note (no unit test — this is shell + git).**

There is no unit test for the shell script. Verify by reasoning + a local smoke where possible:
Run: `REPO_HOST=gitlab GITLAB_TOKEN=xyz bash scripts/git-askpass.sh "Username for 'https://gl.example': "` → expect `oauth2`.
Run: `REPO_HOST=gitlab GITLAB_TOKEN=xyz bash scripts/git-askpass.sh "Password for 'https://gl.example': "` → expect `xyz`.
Run: `bash scripts/git-askpass.sh "Username for 'https://github.com': "` → expect `x-access-token` (github default path unchanged).
Record the outputs in the task report.

- [ ] **Step 4: Full suite (unaffected) + commit.**

Run: `npm test` (no TS changed; confirm still green).

```bash
git add scripts/git-askpass.sh .env.example
git commit -m "feat(auth): host-aware git-askpass — GitLab oauth2 + GITLAB_TOKEN (closes B5)"
```

---

## Task 4: Docs + acceptance

**Files:**
- Create: `docs/guides/gitlab-setup.md`
- Modify: `docs/architecture/backends.md`

**Interfaces:** none (docs). This task also runs the acceptance greps.

- [ ] **Step 1: Write `docs/guides/gitlab-setup.md`.** Cover, as prose (one line per bullet):

- **Overview:** running Archie against self-hosted GitLab Premium via `REPO_HOST=gitlab`; GitHub stays the default.
- **Bot user + token:** create a dedicated bot user; a group (or project) access token with scopes `api, read_repository, write_repository`; set `GITLAB_TOKEN`, `GITLAB_BOT_USERNAME`, and optional `GITLAB_BOT_NAME`/`GITLAB_BOT_EMAIL`.
- **Env:** `REPO_HOST=gitlab`, `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GIT_ASKPASS=/app/scripts/git-askpass.sh`, and `NODE_EXTRA_CA_CERTS` for an internal CA. Note the VPN-internal reachability requirement.
- **Webhook config:** add a project/group webhook → URL `https://<archie-host>/webhooks/gitlab`, Secret token = `GITLAB_WEBHOOK_SECRET`, triggers: Merge request events, Comments (notes), Push events, Pipeline events. Delivery must reach Archie from inside the VPN.
- **Tier notes (Premium):** approval rules + the `approved` webhook are available (approval-driven merges work). The security/vulnerability API is **Ultimate-only** — `securityAlerts` capability is `false` on Premium, and the `list_code_scanning_alerts`/`get_code_scanning_alert` tools return "not available on this repo host". Reviews are synthesized (`changes_requested` from unresolved reviewer discussions; `reviewStates=false`).
- **Protected branches / merge settings:** recommend protected default branch + required approvals as a host-side backstop (Archie orchestrates merges by default; native "merge when pipeline succeeds" is available via the `nativeAutoMerge` capability but not used by default).
- **Capability probe:** at boot Archie calls `GET /license`; on Premium it logs the plan and keeps `securityAlerts=false`.
- **E2E checklist** (see Step 2).

- [ ] **Step 2: Add the live-instance E2E checklist** to `gitlab-setup.md` (owner-run — Archie can't reach the VPN instance from CI). Include:

- Boot with `REPO_HOST=gitlab`: `/health` shows `backends.repoHost=gitlab`; boot log shows the capability matrix (`securityAlerts=false` on Premium).
- Clone + auth: an agent clones a GitLab project (base cache + shared clone), fetches, commits, and **pushes** a branch (validates `git-askpass.sh` GitLab path end-to-end).
- CR lifecycle: create MR → review-comment wake-up → PM responds → approve (Premium `approved` webhook → merge check) → merge.
- Reviews (D2): an unresolved reviewer discussion surfaces as `changes_requested` via `get_pr_reviews`; resolving it clears it.
- CI: a failing pipeline wakes the PM (`workflow_run` failure → existing_task); `get_check_run` on a `/-/jobs/<id>` and `/-/pipelines/<id>` URL returns the job/pipeline with the failing log tail.
- **Positioned review comment** (`addReviewComment`): resolves the `// E2E-VERIFY` for the diff-note `position` shape.
- Conflict path: a dirty MR (`detailed_merge_status=conflict` → `dirty`) notifies the PM.
- **N/A on Premium:** the vulnerabilities/code-scanning path (Ultimate-only) — skip unless upgraded.

- [ ] **Step 3: Update `docs/architecture/backends.md`.**

- In the overview diagram / prose, promote GitLab from "Phase 1: pending" to a real second `RepoHost` (`GitLabHost`, `src/connectors/gitlab/`).
- Note `GITLAB_CAPABILITIES_DEFAULT` (least-capable: `reviewStates:false`, `securityAlerts:false` until an Ultimate `/license` probe, `nativeAutoMerge:true`, `reReviewRequest:false`) and the boot-time `/license` probe.
- Update the "Intentionally deferred" section: `askpassToken()` is now wired (T3, B5 done); `merge.ts` now lives in `connectors/shared/` (A4 done); the knowledge-log prefix is now host-derived. Leave `getLlmOneShot()` runtime switch (Phase 2) and the `github→neutral` rename (Phase 4) as still-deferred.
- Note the GitLab vendor-isolation gate (no GitLab REST outside `src/connectors/gitlab/`).

- [ ] **Step 4: Run the acceptance greps + full suite.**

```bash
echo "=== GitLab REST confined to connectors/gitlab (expect empty) ===" && grep -rn "api/v4\|PRIVATE-TOKEN" src --include="*.ts" | grep -v "connectors/gitlab" || echo CLEAN
echo "=== @octokit confined to connectors/github (expect empty) ===" && grep -rn "@octokit" src --include="*.ts" | grep -v "connectors/github" || echo CLEAN
echo "=== ports still free of connector imports (expect empty) ===" && grep -rn "from '.*connectors/" src/ports/ || echo CLEAN
npm run typecheck && npm test
```
Expected: all CLEAN; suite green.

- [ ] **Step 5: Commit.**

```bash
git add docs/guides/gitlab-setup.md docs/architecture/backends.md
git commit -m "docs(gitlab): operator setup guide + E2E checklist; promote GitLab to a real repo host in backends.md"
```

---

## Self-Review

- **Spec coverage:** clone/askpass host-awareness incl. `askpassToken`/B5 (T2/T3); `github:` log prefix neutralized (T1); `gitlab-setup.md` + `backends.md` update (T4); acceptance greps (T4). Premium-tier reality (approvals yes, vuln no) reflected in caps behavior + docs + E2E.
- **Placeholder scan:** none. The git-auth end-to-end (esp. agent push) is explicitly an E2E-VERIFY gate (shell + git + sandbox can't be unit-tested); the checklist names it.
- **Type/behavior consistency:** `repoCloneUrl`/`repoEventPrefix` are env-driven, cycle-free; GitHub defaults are byte-identical (`https://github.com/...`, `github:` prefix, `x-access-token`); GitLab branches are additive.
- **P1:** every change no-ops on the default `REPO_HOST=github` path (verified by the unmodified suite).
- **Deferred (unchanged):** `getLlmOneShot()` runtime switch (Phase 2); `github→neutral` method/field rename (Phase 4); shared webhook-dispatch consolidation; `checks_ready` debounce for GitLab pipelines. Vulnerabilities/security path is dormant on Premium.
