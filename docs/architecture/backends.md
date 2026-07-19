# Agent Runtime Abstraction

Archie's engineering path depends on an agent runtime: what actually executes the coding-agent process. This seam sits between Archie's business logic and that runtime so a second runtime can be added without touching call sites. It ships with two concrete implementations: the Claude Agent SDK (default) and `opencode` (`AGENT_RUNTIME=opencode`) — a full runtime alongside it, see `docs/architecture/opencode-runtime.md`. A resolver in `src/system/backends.ts` is the single place that picks between runtimes.

## Overview

One port, one resolver:

```
                       src/system/backends.ts
                (AGENT_RUNTIME env resolution + gate)
                                |
                         AgentRuntime port
                    (src/ports/agent-runtime.ts)
                                |
                      +---------+---------+
                      |                   |
                ClaudeSdkRuntime    OpencodeRuntime
                (src/runtime/       (src/runtime/
                  claude/)            opencode/)
```

Callers never import the Claude SDK (or the opencode SDK) directly to reach these capabilities — they call `getAgentRuntime()` / `getLlmOneShot()` from `src/system/backends.ts` and get back a port-typed object.

## The `src/ports/` interfaces

The interfaces live under `src/ports/` and are re-exported from `src/ports/index.ts`.

- `agent-runtime.ts` — the `AgentRuntime` interface: `capabilities()` plus `spawn(agent, task)`, which mirrors the pre-existing `spawnAgent(agent, task)` call shape (mutates `agent.sandbox` / `agent.handle`), and an optional `shutdown()` for runtimes that hold OS resources (the opencode runtime tears down its embedded serve child + bridge; the Claude runtime has no hook).
- `llm-one-shot.ts` — the `LlmOneShot` interface: `text(req)` and `json(req)` for one-shot prompt-in/text-or-JSON-out calls, used by title generation, memory extraction/housekeeping, and the (disabled) triage agent. The port owns the SDK `query()` plumbing and env allowlist; callers keep their own schema construction and validation.
- `capabilities.ts` — the `RuntimeCapabilities` descriptor plus the concrete `CLAUDE_RUNTIME_CAPABILITIES` and `OPENCODE_RUNTIME_CAPABILITIES` constants (see "Capability descriptors" below).
- `index.ts` — barrel re-exporting all of the above, so consumers can `import { AgentRuntime, ... } from '../ports/index.js'`.

## Resolution — `src/system/backends.ts`

One environment variable selects the active runtime:

- `AGENT_RUNTIME` — defaults to `claude` when unset. Supported values: `claude` (default) and `opencode` (the full opencode runtime — see `docs/architecture/opencode-runtime.md`; requires an `ARCHIE_OPENCODE_MODEL_*` route).

`resolveAgentRuntimeKind()` reads and normalizes (trim + lowercase) the variable. `assertBackendConfig()` validates the resolved value against the supported list and throws an actionable error if it is unsupported. When `AGENT_RUNTIME=opencode`, it additionally requires an `ARCHIE_OPENCODE_MODEL_*` route to be set. `src/index.ts` calls `assertBackendConfig()` early in boot, before workdir bootstrap, so a misconfigured deployment fails fast instead of erroring deep inside agent-spawn.

`getBackendMatrix()` returns `{ runtime }` for the resolved kind. It backs both the boot-time log line (`Backends: runtime=claude`) and the `backends` field on the `GET /health` response, so the active configuration is observable at runtime without reading environment variables directly.

Two factory functions hand callers a concrete, port-typed backend:

- `getAgentRuntime(): AgentRuntime` — returns the `claudeSdkRuntime` singleton for `AGENT_RUNTIME=claude`, or the `opencodeRuntime` singleton for `AGENT_RUNTIME=opencode`. Unsupported runtimes default to claude defensively and log a warning (already rejected at boot by `assertBackendConfig()`).
- `getLlmOneShot(): LlmOneShot` — switches on the runtime: `claudeLlmOneShot` for `claude`, `opencodeLlmOneShot` for `opencode` (a tiny utility serve outside the per-agent pool — see `docs/architecture/opencode-runtime.md`).

The four one-shot LLM call sites (title generation, memory extractor, memory housekeeping, triage) go through `getLlmOneShot()`, and agent spawn goes through `getAgentRuntime()`.

## The Claude SDK barrel and vendor isolation

`src/runtime/claude/sdk.ts` is the one file in the codebase allowed to import `@anthropic-ai/claude-agent-sdk`. It re-exports the symbols the rest of the runtime layer needs (`query`, `tool`, `createSdkMcpServer`, and the `HookCallbackMatcher` / `HookJSONOutput` types). Every other file that needs SDK symbols imports them from this barrel rather than from the package directly, so a grep for the vendor package outside `src/runtime/claude/` stays empty and a future SDK version bump touches one file.

## Capability descriptors

`RuntimeCapabilities` (in `src/ports/capabilities.ts`) documents where a runtime cannot match a capability, so the gap is declared and degraded gracefully — never silent. `CLAUDE_RUNTIME_CAPABILITIES` advertises all five (`osSandbox`, `skills`, `oneMillionContext`, `effort`, `backgroundTasks`); `OPENCODE_RUNTIME_CAPABILITIES` advertises `osSandbox`, `skills`, and `oneMillionContext`, and declares `effort: false` (opencode has no per-turn reasoning-effort knob) and `backgroundTasks: false` (opencode subtasks aren't yet wired into busy/idle accounting). The flags are declarative today — see `docs/architecture/opencode-runtime.md` for the runtime detail behind each.
