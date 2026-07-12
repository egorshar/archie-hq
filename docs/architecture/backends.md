# Backend Abstraction (Repo Host / Agent Runtime)

Archie's engineering path depends on two external backends: a repo host (where pull/merge requests, reviews, and CI live) and an agent runtime (what actually executes the coding agent process). Phase 0 introduced a seam between Archie's business logic and both backends so that a second repo host or a second agent runtime could be added later without touching call sites. Phase 1 landed that second repo host: GitLab (self-hosted, Premium tier) is now a real, fully wired `RepoHost` alongside GitHub. The agent runtime seam now has a second concrete implementation too: `opencode` (`AGENT_RUNTIME=opencode`) is a full runtime alongside the Claude Agent SDK — see `docs/architecture/opencode-runtime.md`. A resolver in `src/system/backends.ts` is the single place that picks between backends on each seam.

## Overview

Two ports, one resolver:

```
                       src/system/backends.ts
              (REPO_HOST, AGENT_RUNTIME env resolution + gate)
                                |
                +---------------+---------------+
                |                               |
         RepoHost port                   AgentRuntime port
      (src/ports/repo-host.ts)        (src/ports/agent-runtime.ts)
                |                               |
        +-------+-------+              +---------+---------+
        |               |             |                   |
   GitHubHost       GitLabHost   ClaudeSdkRuntime    OpencodeRuntime
   (connectors/     (connectors/  (src/runtime/       (src/runtime/
     github/)          gitlab/)      claude/)            opencode/)
```

Callers never import `GitHubClient` or the Claude SDK directly to reach these capabilities -- they call `getRepoHost()` / `getAgentRuntime()` / `getLlmOneShot()` from `src/system/backends.ts` and get back a port-typed object. A related but separate seam, `RepoHostEventSource`, normalizes inbound webhook events so the routing logic that decides "wake the PM" vs "run a merge check" is host-agnostic (see `src/connectors/shared/cr-router.ts`).

## The `src/ports/` interfaces

All four interfaces (plus the shared domain types) live under `src/ports/` and are re-exported from `src/ports/index.ts`.

- `repo-host-types.ts` -- host-neutral domain types shared by `RepoHost` methods: `PRStatus`, `PRReview`, `ReviewThread`, `ReviewThreadComment`, `PRComment`, `PRChecksReport`, `PRCheckEntry`, `MergeableState`, `CheckConclusion` (extracted from `src/agents/tools.ts`), plus the canonical result/report shapes `CreatePRResult`, `PRListItem`, `PRListFilters`, `PRDetails`, `CheckRunAnnotation`, `CheckRunReport`, `WorkflowJobEntry`, `WorkflowRunReport`, `CodeScanningAlertInstance`, `CodeScanningAlert`, `CodeScanningAlertFilters` (relocated out of `connectors/github/client.ts`). Both `tools.ts` and `client.ts` re-export their respective sets so existing importers are unaffected. These are plain data shapes with no vendor types embedded: GitHub produces them directly, and a future GitLab host maps its API responses into the same canonical shapes rather than importing from a sibling connector.
- `capabilities.ts` -- `RepoHostCapabilities` and `RuntimeCapabilities` descriptors, plus the concrete `GITHUB_CAPABILITIES` and `CLAUDE_RUNTIME_CAPABILITIES` constants (see "Capability descriptors" below).
- `repo-host.ts` -- the `RepoHost` interface: PR/MR lifecycle, reviews, CI checks, repo listing, and code-scanning alerts, keyed by `repo` as `"owner/name"`. Method names stay PR-oriented (`getPRStatus`, `createPullRequest`, ...) in Phase 0 -- neutral CR-renaming is a Phase 4 concern.
- `repo-host-events.ts` -- `RepoHostEventSource` (signature verification, payload parsing, self-event detection) plus the host-neutral `NormalizedEventContext`, `InternalRouteAction`, and `RouteResult` types consumed by the shared router.
- `agent-runtime.ts` -- the `AgentRuntime` interface: `capabilities()` plus `spawn(agent, task)`, which mirrors the pre-existing `spawnAgent(agent, task)` call shape (mutates `agent.sandbox` / `agent.handle`). The richer `AgentSpawnSpec` / `RuntimeEvent` normalization is deferred to Phase 2.
- `llm-one-shot.ts` -- the `LlmOneShot` interface: `text(req)` and `json(req)` for one-shot prompt-in/text-or-JSON-out calls, used by title generation, memory extraction/housekeeping, and the (disabled) triage agent. The port owns the SDK `query()` plumbing and env allowlist; callers keep their own schema construction and validation.
- `index.ts` -- barrel re-exporting all of the above, so consumers can `import { RepoHost, AgentRuntime, ... } from '../ports/index.js'`.

## Resolution — `src/system/backends.ts`

Two environment variables select the active backend per seam:

- `REPO_HOST` -- defaults to `github` when unset. Supported values: `github`, `gitlab` (Phase 1).
- `AGENT_RUNTIME` -- defaults to `claude` when unset. Supported values: `claude` (default) and `opencode` (the full opencode runtime -- see `docs/architecture/opencode-runtime.md`; requires an `ARCHIE_OPENCODE_MODEL_*` route).

`resolveRepoHostKind()` and `resolveAgentRuntimeKind()` read and normalize (trim + lowercase) those variables. `assertBackendConfig()` validates the resolved values against the supported lists and throws an actionable error if either is unsupported -- it distinguishes a genuinely unknown value ("is invalid") from a value that is a real backend but not available yet ("is not available in this build yet"). When `AGENT_RUNTIME=opencode`, it additionally requires an `ARCHIE_OPENCODE_MODEL_*` route to be set. When `REPO_HOST=gitlab`, `assertBackendConfig()` additionally requires `GITLAB_BASE_URL`, `GITLAB_TOKEN`, and `GITLAB_WEBHOOK_SECRET` to be set, and throws naming whichever are missing. `src/index.ts` calls `assertBackendConfig()` early in boot, before workdir bootstrap, so a misconfigured deployment fails fast instead of erroring deep inside agent-spawn or webhook handling.

`getBackendMatrix()` returns `{ repoHost, runtime }` for the resolved kinds. It backs both the boot-time log line (`Backends: repoHost=github runtime=claude`, or `repoHost=gitlab` when selected) and the `backends` field on the `GET /health` response, so the active configuration is observable at runtime without reading environment variables directly. When `REPO_HOST=gitlab`, boot also calls `getGitLabHost().probeCapabilities()`, which hits `GET /license` and raises `securityAlerts` to `true` only on an Ultimate-licensed instance (see "Capability descriptors" below); the result is logged (`GitLab: license plan=... → securityAlerts=...`).

Three factory functions hand callers a concrete, port-typed backend:

- `getRepoHost(): RepoHost | null` -- returns the `GitHubClient` singleton (via `getGitHubClient()`) when `REPO_HOST=github`, or the `GitLabHost` singleton (via `getGitLabHost()`) when `REPO_HOST=gitlab`. GitHub returns `null` when its App environment is not configured (mirroring pre-Phase-0 behavior; callers already handle a null host by disabling PR tools). Unsupported hosts return `null` defensively and log a warning, but in practice `assertBackendConfig()` has already rejected them at boot.
- `getAgentRuntime(): AgentRuntime` -- returns the `claudeSdkRuntime` singleton for `AGENT_RUNTIME=claude`, or the `opencodeRuntime` singleton for `AGENT_RUNTIME=opencode`. Unsupported runtimes default to claude defensively and log a warning (already rejected at boot by `assertBackendConfig()`).
- `getLlmOneShot(): LlmOneShot` -- switches on the runtime: `claudeLlmOneShot` for `claude`, `opencodeLlmOneShot` for `opencode` (a tiny utility serve outside the per-agent pool — see `docs/architecture/opencode-runtime.md`).

Call sites that previously imported `getGitHubClient()` or `createGitHubClient()` directly (`src/agents/tools.ts`, `src/connectors/github/merge.ts`) now go through `getRepoHost()` instead, and the four one-shot LLM call sites (title generation, memory extractor, memory housekeeping, triage) go through `getLlmOneShot()`.

## The Claude SDK barrel and vendor isolation

`src/runtime/claude/sdk.ts` is the one file in the codebase allowed to import `@anthropic-ai/claude-agent-sdk`. It re-exports the symbols the rest of the runtime layer needs (`query`, `tool`, `createSdkMcpServer`, and the `HookCallbackMatcher` / `HookJSONOutput` types). Every other file that needs SDK symbols imports them from this barrel rather than from the package directly, so a grep for the vendor package outside `src/runtime/claude/` stays empty and a future SDK version bump or provider swap touches one file.

The same isolation principle applies on the repo-host side, once per host: `@octokit` imports are confined to `src/connectors/github/`, and GitLab REST calls (`api/v4` paths, the `PRIVATE-TOKEN` header) are confined to `src/connectors/gitlab/` -- every GitLab REST call flows through the single `glRequest`/`glRequestAll` seam in `src/connectors/gitlab/http.ts`. `RepoHost` and `RepoHostEventSource` consumers elsewhere in the codebase depend only on the port types, never on a vendor SDK or a host's raw REST shape directly. This is a standing gate, not just a one-time check: a grep for `api/v4|PRIVATE-TOKEN` outside `connectors/gitlab` (and `@octokit` outside `connectors/github`) is expected to stay empty as the codebase grows.

Two concrete implementations sit behind the SDK barrel:

- `src/runtime/claude/runtime.ts` -- `ClaudeSdkRuntime`, which implements `AgentRuntime` by delegating `spawn(agent, task)` straight to the existing `spawnAgent()` in `src/agents/spawn.ts`. The SDK event loop, hooks, sandbox, and session recovery all stay in `spawn.ts` unchanged; this class is a thin conformance wrapper.
- `src/runtime/claude/llm-one-shot.ts` -- `ClaudeLlmOneShot`, which implements `LlmOneShot.text()` and `LlmOneShot.json()` on top of the SDK's `query()`. It consolidates the env allowlist and event-accumulation logic that title generation, memory extraction/housekeeping, and triage each used to hand-roll, while keeping behavior byte-identical to the pre-consolidation call sites (`text()` accumulates `assistant` text blocks and overrides with a non-empty `result` string on `subtype: 'success'`; `json()` returns the `structured_output` from the first successful `result` event).

## Capability descriptors

`src/ports/capabilities.ts` declares what each backend can and cannot do, so gaps are surfaced explicitly rather than failing silently (or crashing) when a less-capable backend is swapped in later.

`RepoHostCapabilities` describes: `reviewStates` (distinct approved/changes-requested review states vs. approvals-and-notes-only), `securityAlerts` (code-scanning/security-alert availability), `nativeAutoMerge` (host-native "merge when pipeline succeeds," which GitHub lacks and Archie orchestrates itself), and `reReviewRequest` (whether re-review can be requested from prior reviewers). `GITHUB_CAPABILITIES` sets `reviewStates`, `securityAlerts`, and `reReviewRequest` to `true` and `nativeAutoMerge` to `false`.

`GITLAB_CAPABILITIES_DEFAULT` is GitLab's least-capable baseline, applied unconditionally at construction: `reviewStates: false` (GitLab has approvals + discussion notes, not GitHub-style distinct `approved`/`changes_requested` review states -- Archie synthesizes `changes_requested` from unresolved reviewer discussions, design decision D2), `securityAlerts: false`, `nativeAutoMerge: true` (GitLab's native "merge when pipeline succeeds," unused by default -- Archie keeps orchestrating merges itself), `reReviewRequest: false`. `securityAlerts` starts `false` and is raised to `true` only by the boot-time capability probe: `GitLabHost.probeCapabilities()` calls `GET /license` and sets `securityAlerts: true` when the reported plan is `ultimate`; any other plan (including Premium, the current deployment target) or a failed/unreachable probe leaves it `false`, since the vulnerability API that backs code-scanning alerts is Ultimate-only. `src/index.ts` invokes this probe once at boot when `REPO_HOST=gitlab`, right after `assertBackendConfig()`.

`RuntimeCapabilities` describes: `osSandbox` (built-in OS-level sandboxing), `skills` (native Skills support), `oneMillionContext` (1M-context model availability), `effort` (per-turn reasoning-effort control), and `backgroundTasks` (background/subagent tasks surfaced as events). `CLAUDE_RUNTIME_CAPABILITIES` sets all five to `true`.

`RepoHost.capabilities()` and `AgentRuntime.capabilities()` return these descriptors on the active backend instance, so callers can branch on capability rather than on backend kind. The `list_code_scanning_alerts` / `get_code_scanning_alert` tool handlers already do this: they short-circuit with a clear "not available on this repo host" message when `capabilities().securityAlerts` is `false`, so a less-capable host (GitLab on anything short of Ultimate) degrades gracefully instead of stubbing the methods (spec P3).

## Scope: GitHub and GitLab repo hosts, Claude runtime

Two repo hosts are wired today -- `github` (`GitHubHost`/`GitHubClient`, `src/connectors/github/`) and `gitlab` (`GitLabHost`, `src/connectors/gitlab/`) -- and one agent runtime (`claude`). `AGENT_RUNTIME=opencode` is still not functional:

- `AGENT_RUNTIME=opencode` is rejected by `assertBackendConfig()` at boot with "not available in this build yet" -- opencode support is Phase 2.
- Any other value for either `REPO_HOST` or `AGENT_RUNTIME` is rejected as invalid.
- `REPO_HOST=gitlab` additionally requires `GITLAB_BASE_URL`, `GITLAB_TOKEN`, and `GITLAB_WEBHOOK_SECRET`; `assertBackendConfig()` throws naming whichever are missing. See `docs/guides/gitlab-setup.md` for the full operator setup (bot user, token scopes, webhook config, live-instance E2E checklist).

The port interfaces (`RepoHost`, `RepoHostEventSource`, `AgentRuntime`, `LlmOneShot`) are shaped to accommodate the still-missing backend -- e.g. `kind: 'claude' | 'opencode'` on `AgentRuntime` -- but the resolver's supported-values lists are the actual gate. Widening `SUPPORTED_RUNTIMES` in `src/system/backends.ts` (plus adding the concrete implementation) is what will turn on opencode; the interfaces themselves do not need to change.

**Vendor isolation gate.** No GitLab REST call (`api/v4` paths, `PRIVATE-TOKEN` header) may appear outside `src/connectors/gitlab/` -- everything routes through `glRequest`/`glRequestAll` in `src/connectors/gitlab/http.ts`. This mirrors the pre-existing `@octokit`-confined-to-`connectors/github/` gate. Both are acceptance-grep invariants (see the repo's Phase 1 acceptance checks) and should stay part of any future repo-host-adjacent PR's review.

## Intentionally deferred to the phase that first needs them

A few seam details are deliberately left thin until a further consumer forces the decision, to avoid speculative abstraction:

- **`getLlmOneShot()` runtime switch (Phase 2).** It always returns the Claude implementation today; it will branch on `AGENT_RUNTIME` once the opencode one-shot provider exists.
- **`github → neutral` method/field rename (Phase 4).** `RepoHost` methods and shared types still use GitHub-flavored names (`getPRStatus`, `createPullRequest`, `githubRepo`, ...) even though `GitLabHost` implements the same interface today. Renaming to host-neutral vocabulary (`getCrStatus`, `createChangeRequest`, ...) is a larger, mechanical, high-blast-radius change deferred to Phase 4 rather than bundled with GitLab's initial landing.

Two seams that were deferred in the Phase 0 write-up are now done, not deferred:

- **`cr-router` → `merge.ts` dependency.** The host-agnostic merge orchestrator (`checkAndMergeLinkedPRs`) now lives in `src/connectors/shared/merge.ts` rather than `connectors/github/merge.ts` (A4), so `src/connectors/shared/cr-router.ts` depends on a shared module, not a specific connector.
- **Git authentication is env-driven, not `askpassToken()`-driven (B5).** `scripts/git-askpass.sh` is host-aware and reads credentials from the environment directly: `REPO_HOST=gitlab` selects username `oauth2` / password `$GITLAB_TOKEN`; the GitHub default selects `x-access-token` / a generated App installation token. `repoCloneUrl()`/`repoEventPrefix()` (`src/connectors/shared/repo-url.ts`) derive the clone URL and knowledge-log destination prefix (`github:` / `gitlab:`) from the same env, so the base cache, shared clones, and startup clone all resolve to the correct host without a host-specific branch at each call site. `RepoHost.askpassToken()` exists as a typed accessor on the port and is implemented by `GitLabHost` (`src/connectors/gitlab/client.ts`) but not by `GitHubClient`; it is not called anywhere today, since the shell-based askpass path above reads tokens from the environment instead. It remains an unused seam, not "wired end-to-end."
