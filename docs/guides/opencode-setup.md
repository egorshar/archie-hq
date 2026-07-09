# opencode runtime setup guide

This guide covers running Archie's agent runtime on [opencode](https://opencode.ai) instead of the Claude Agent SDK, selected via `AGENT_RUNTIME=opencode`. This is Phase 2-A: the opencode-backed `AgentRuntime` boots, creates sessions, prompts, and routes models, but it does not yet expose Archie's tools to the opencode agent — see "What Phase 2-A does and does not do" below before relying on this for real tasks. `AGENT_RUNTIME=claude` remains the default and is unaffected by anything in this guide.

## Overview

Setting `AGENT_RUNTIME=opencode` swaps the active `AgentRuntime` and `LlmOneShot` implementations from the Claude Agent SDK to an embedded opencode server (`src/runtime/opencode/`), resolved by `src/system/backends.ts` (see `docs/architecture/backends.md` for the full backend-resolution picture). Archie's own imports of the opencode SDK are confined to `src/runtime/opencode/`, mirroring the vendor-isolation pattern already used for the Claude SDK (`src/runtime/claude/sdk.ts`) and the GitHub/GitLab connectors.

## Installing opencode

Two separate things are required, and both matter:

- **The `@opencode-ai/sdk` npm package** — already pinned in `package.json` (`"@opencode-ai/sdk": "1.17.16"`) and installed by `npm install`. This is the TypeScript client `src/runtime/opencode/server.ts` uses to start and talk to the embedded server.
- **The `opencode` CLI binary, on `PATH`** — the SDK package does not bundle a server binary; `createOpencode()` spawns the `opencode` executable itself (`opencode serve --hostname=... --port=...`, via `cross-spawn`) and talks to it over HTTP. If `opencode` is not on `PATH`, spawning the embedded server fails at first use — the first PM/specialist agent spawn or one-shot call under `AGENT_RUNTIME=opencode` — not at boot.

Install the CLI with `npm install -g opencode-ai@latest` or the official install script (`curl -fsSL https://opencode.ai/install | bash`); check opencode's own docs for the currently recommended method. In a container image, install it in the same build stage as Archie's other runtime dependencies so it ends up on `PATH` for the app user.

The embedded server is started lazily, once per process, on an ephemeral port (`port: 0`), and reused for the rest of the process's lifetime — it is not restarted per task or per agent (`getOpencodeClient()` in `src/runtime/opencode/server.ts`).

## Provider/auth config — `OPENCODE_CONFIG_PATH`

opencode resolves its own provider and auth configuration (API keys, provider endpoints, model aliases, etc.) from its standard config locations, one of which is the file at `OPENCODE_CONFIG_PATH`. Archie's TypeScript code never reads this variable itself — it is plain environment passed through to the spawned `opencode` process, which reads it directly. Point it at a JSON config file describing your providers, e.g.:

```bash
OPENCODE_CONFIG_PATH=/app/opencode.json
```

See opencode's own configuration docs for that file's schema. Archie only needs the resulting `provider/model` ids to line up with what you set in `ARCHIE_OPENCODE_MODEL_*` below — opencode config and Archie's model-routing env are two independent things that must agree on the same provider/model strings.

## Model routing — `ARCHIE_OPENCODE_MODEL_*`

Archie's agents pass a *logical* model name (`'opus'`, `'sonnet'`, `'haiku'`, or whatever a specific agent definition pins via its own `model` field) rather than a concrete opencode model id. `resolveOpencodeModel()` (`src/runtime/opencode/model.ts`) maps that logical name to an opencode `{ providerID, modelID }` pair, in this order:

1. **Passthrough** — if the logical name itself contains a `/` (e.g. an agent is configured with `model: 'anthropic/claude-opus-4-8'` directly), it's split on the first `/` into `providerID`/`modelID` and used as-is; no env lookup happens at all.
2. **Per-tier env** — otherwise, `ARCHIE_OPENCODE_MODEL_<UPPER(name)>` (e.g. `ARCHIE_OPENCODE_MODEL_SONNET` for the logical name `'sonnet'`). The value must be a `provider/model` string.
3. **Default env** — `ARCHIE_OPENCODE_MODEL_DEFAULT`, same `provider/model` format, used when no per-tier var matched.
4. **Throw** — if neither resolves, `resolveOpencodeModel()` throws an error naming exactly which env var to set; it never silently guesses a model.

By default, the PM agent's logical model is `'opus'` and other agents (specialists, plugin agents) default to `'sonnet'`, unless an agent definition pins its own `model`. Concretely, with:

```bash
ARCHIE_OPENCODE_MODEL_DEFAULT=anthropic/claude-haiku-4-5
ARCHIE_OPENCODE_MODEL_OPUS=anthropic/claude-opus-4-8
ARCHIE_OPENCODE_MODEL_SONNET=anthropic/claude-sonnet-5
```

the PM resolves to `anthropic/claude-opus-4-8`, a specialist resolves to `anthropic/claude-sonnet-5`, and any other logical name with no per-tier var of its own (e.g. a one-shot call requesting `'haiku'` with no `ARCHIE_OPENCODE_MODEL_HAIKU` set) falls back to `anthropic/claude-haiku-4-5` via `_DEFAULT`.

## Boot-time validation

`assertBackendConfig()` (`src/system/backends.ts`), called once early in boot, fails fast if `AGENT_RUNTIME=opencode` is set with no model route configured at all — that is, no environment variable whose name starts with `ARCHIE_OPENCODE_MODEL_` is present anywhere in `process.env`. The thrown error names both `ARCHIE_OPENCODE_MODEL_DEFAULT` and the per-tier alternative, so a misconfigured deployment fails at boot with an actionable message instead of failing deep inside the first agent spawn. Note that this check only requires *at least one* such var to exist — setting just `ARCHIE_OPENCODE_MODEL_DEFAULT` satisfies it, but a logical name with neither its own per-tier var nor `_DEFAULT` set still throws later, at resolution time inside `resolveOpencodeModel()`, not at boot.

The resolved backend matrix (`repoHost`/`runtime`) is logged at boot and exposed on `GET /health`, so `runtime=opencode` is observable without reading environment variables directly.

## What Phase 2-A does and does not do

Phase 2-A — the scope of this guide — wires the opencode-backed `AgentRuntime` and `LlmOneShot` into the resolver and gives it a working turn loop:

- **Does:** boot under `AGENT_RUNTIME=opencode`, create an opencode session per agent, send a prompt, stream the assistant's reply into Archie's logs/CLI, reach idle after the reply, and cleanly abort the in-flight prompt on task teardown.
- **Does not yet:** expose any of Archie's tools to the opencode agent. Archie agents normally talk to Slack via the `post_to_user` tool (and complete tasks via `report_completion`); a Phase 2-A opencode agent has no tool bridge at all, so it can investigate and reason within its own session, but it cannot post to Slack, attach artifacts, or complete a task — its replies land only in logs/CLI, never in a Slack thread.

That gap is closed in later phases, not here:

- **Phase 2-B** adds the in-process tool bridge, permission guards, and read-only enforcement — the pieces that let an opencode agent actually call Archie's tools (including `post_to_user`) — plus the live SSE event stream in place of the current single-shot `session.prompt()` return.
- **Phase 2-C** adds `activity.ts` tool-name aliases, a `read_skill` tool / `AGENTS.md` equivalent, and session reset-retry.

Until Phase 2-B lands, treat `AGENT_RUNTIME=opencode` as a plumbing and model-routing validation path, not a way to run real end-user tasks end to end.
