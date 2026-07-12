# Backend Abstraction (Repo Host / Agent Runtime)

Archie's engineering path depends on two external backends: a repo host (where pull/merge requests, reviews, and CI live) and an agent runtime (what actually executes the coding agent process). Phase 0 introduces a seam between Archie's business logic and both backends so that a second repo host (GitLab) or a second agent runtime (opencode) can be added later without touching call sites. Today only one concrete implementation exists per seam -- GitHub for the repo host, the Claude Agent SDK for the runtime -- and a resolver in `src/system/backends.ts` is the single place that picks between them.

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
           GitHubHost                     ClaudeSdkRuntime
     (GitHubClient, connectors/       (src/runtime/claude/runtime.ts)
            github/)
                |                               |
     Phase 1: GitLabHost               Phase 2: OpencodeRuntime
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

- `REPO_HOST` -- defaults to `github` when unset. Phase 0 supports only `github`.
- `AGENT_RUNTIME` -- defaults to `claude` when unset. Phase 0 supports only `claude`.

`resolveRepoHostKind()` and `resolveAgentRuntimeKind()` read and normalize (trim + lowercase) those variables. `assertBackendConfig()` validates the resolved values against the Phase-0 supported lists and throws an actionable error if either is unsupported -- it distinguishes a genuinely unknown value ("is invalid") from a value that is a real backend but not available yet ("is not available in this build yet"). `src/index.ts` calls `assertBackendConfig()` early in boot, before workdir bootstrap, so a misconfigured deployment fails fast instead of erroring deep inside agent-spawn or webhook handling.

`getBackendMatrix()` returns `{ repoHost, runtime }` for the resolved kinds. It backs both the boot-time log line (`Backends: repoHost=github runtime=claude`) and the `backends` field on the `GET /health` response, so the active configuration is observable at runtime without reading environment variables directly.

Three factory functions hand callers a concrete, port-typed backend:

- `getRepoHost(): RepoHost | null` -- returns the `GitHubClient` singleton (via `getGitHubClient()`) when `REPO_HOST=github`, or `null` when the GitHub App environment is not configured (mirroring the pre-Phase-0 behavior; callers already handle a null host by disabling PR tools). Unsupported hosts return `null` defensively and log a warning, but in practice `assertBackendConfig()` has already rejected them at boot.
- `getAgentRuntime(): AgentRuntime` -- returns the `claudeSdkRuntime` singleton for `AGENT_RUNTIME=claude`.
- `getLlmOneShot(): LlmOneShot` -- returns the `claudeLlmOneShot` singleton. Phase 0 has only one LLM provider, so this is unconditional today; it is tied to the runtime selection conceptually even though it does not yet switch on `AGENT_RUNTIME`.

Call sites that previously imported `getGitHubClient()` or `createGitHubClient()` directly (`src/agents/tools.ts`, `src/connectors/github/merge.ts`) now go through `getRepoHost()` instead, and the four one-shot LLM call sites (title generation, memory extractor, memory housekeeping, triage) go through `getLlmOneShot()`.

## The Claude SDK barrel and vendor isolation

`src/runtime/claude/sdk.ts` is the one file in the codebase allowed to import `@anthropic-ai/claude-agent-sdk`. It re-exports the symbols the rest of the runtime layer needs (`query`, `tool`, `createSdkMcpServer`, and the `HookCallbackMatcher` / `HookJSONOutput` types). Every other file that needs SDK symbols imports them from this barrel rather than from the package directly, so a grep for the vendor package outside `src/runtime/claude/` stays empty and a future SDK version bump or provider swap touches one file.

The same isolation principle applies on the repo-host side: `@octokit` imports are confined to `src/connectors/github/`. `RepoHost` and `RepoHostEventSource` consumers elsewhere in the codebase depend only on the port types, never on Octokit directly.

Two concrete implementations sit behind the SDK barrel:

- `src/runtime/claude/runtime.ts` -- `ClaudeSdkRuntime`, which implements `AgentRuntime` by delegating `spawn(agent, task)` straight to the existing `spawnAgent()` in `src/agents/spawn.ts`. The SDK event loop, hooks, sandbox, and session recovery all stay in `spawn.ts` unchanged; this class is a thin conformance wrapper.
- `src/runtime/claude/llm-one-shot.ts` -- `ClaudeLlmOneShot`, which implements `LlmOneShot.text()` and `LlmOneShot.json()` on top of the SDK's `query()`. It consolidates the env allowlist and event-accumulation logic that title generation, memory extraction/housekeeping, and triage each used to hand-roll, while keeping behavior byte-identical to the pre-consolidation call sites (`text()` accumulates `assistant` text blocks and overrides with a non-empty `result` string on `subtype: 'success'`; `json()` returns the `structured_output` from the first successful `result` event).

## Capability descriptors

`src/ports/capabilities.ts` declares what each backend can and cannot do, so gaps are surfaced explicitly rather than failing silently (or crashing) when a less-capable backend is swapped in later.

`RepoHostCapabilities` describes: `reviewStates` (distinct approved/changes-requested review states vs. approvals-and-notes-only), `securityAlerts` (code-scanning/security-alert availability), `nativeAutoMerge` (host-native "merge when pipeline succeeds," which GitHub lacks and Archie orchestrates itself), and `reReviewRequest` (whether re-review can be requested from prior reviewers). `GITHUB_CAPABILITIES` sets `reviewStates`, `securityAlerts`, and `reReviewRequest` to `true` and `nativeAutoMerge` to `false`.

`RuntimeCapabilities` describes: `osSandbox` (built-in OS-level sandboxing), `skills` (native Skills support), `oneMillionContext` (1M-context model availability), `effort` (per-turn reasoning-effort control), and `backgroundTasks` (background/subagent tasks surfaced as events). `CLAUDE_RUNTIME_CAPABILITIES` sets all five to `true`.

`RepoHost.capabilities()` and `AgentRuntime.capabilities()` return these descriptors on the active backend instance, so callers can branch on capability rather than on backend kind. The `list_code_scanning_alerts` / `get_code_scanning_alert` tool handlers already do this: they short-circuit with a clear "not available on this repo host" message when `capabilities().securityAlerts` is `false`, so a less-capable host (e.g. GitLab CE) degrades gracefully instead of stubbing the methods (spec P3).

## Phase-0 scope: GitHub and Claude only

Phase 0 wires exactly one repo host (`github`) and one agent runtime (`claude`). No other value is functional yet, regardless of what the port interfaces model:

- `REPO_HOST=gitlab` is rejected by `assertBackendConfig()` at boot with "not available in this build yet" -- GitLab support is Phase 1.
- `AGENT_RUNTIME=opencode` is rejected the same way -- opencode support is Phase 2.
- Any other value for either variable is rejected as invalid.

The port interfaces (`RepoHost`, `RepoHostEventSource`, `AgentRuntime`, `LlmOneShot`) are already shaped to accommodate those future backends -- e.g. `kind: 'github' | 'gitlab'` and `kind: 'claude' | 'opencode'` -- but the resolver's supported-values lists are the actual gate. Widening `SUPPORTED_REPO_HOSTS` / `SUPPORTED_RUNTIMES` in `src/system/backends.ts` (plus adding the concrete implementation) is what turns on a new backend; the interfaces themselves do not need to change.

## Intentionally deferred to the phase that first needs them

A few seam details are deliberately left thin until the second implementation forces the decision, to avoid speculative abstraction:

- **`cr-router` → `merge.ts` dependency (Phase 1).** `src/connectors/shared/cr-router.ts` imports `checkAndMergeLinkedPRs` from `connectors/github/merge.ts` -- a host-agnostic module depending on a specific connector. It works today because GitHub is the only host; Phase 1 inverts it (inject the merge orchestrator) when a second host's merge path exists.
- **`askpassToken()` wiring (Phase 1).** The method is declared optional on `RepoHost` but is not yet wired into the `GIT_ASKPASS` clone flow, which stays script-driven until GitLab's token provider needs it.
- **`getLlmOneShot()` runtime switch (Phase 2).** It always returns the Claude implementation today; it will branch on `AGENT_RUNTIME` once the opencode one-shot provider exists.
