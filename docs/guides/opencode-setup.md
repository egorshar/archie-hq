# opencode runtime setup guide

This guide covers running Archie's agent runtime on [opencode](https://opencode.ai) instead of the Claude Agent SDK, selected via `AGENT_RUNTIME=opencode`. It is a full runtime: the PM and specialist agents boot, create sessions, use tools (Archie's own plus opencode's built-ins), enforce read-only mode, route models per agent, and drive real end-to-end tasks (investigate → edit → commit → push → open a merge request, posting back to Slack/CLI). `AGENT_RUNTIME=claude` remains the default and is unaffected by anything in this guide.

## Overview

Setting `AGENT_RUNTIME=opencode` swaps the active `AgentRuntime` and `LlmOneShot` implementations from the Claude Agent SDK to an embedded opencode server (`src/runtime/opencode/`), resolved by `src/system/backends.ts` (see `docs/architecture/backends.md` for the full backend-resolution picture). Archie's own imports of the opencode SDK are confined to `src/runtime/opencode/`, mirroring the vendor-isolation pattern already used for the Claude SDK (`src/runtime/claude/sdk.ts`) and the GitHub/GitLab connectors.

## Installing opencode

Two separate things are required, and both matter:

- **The `@opencode-ai/sdk` npm package** — pinned in `package.json` and installed by `npm install`. This is the TypeScript client `src/runtime/opencode/server.ts` uses to start and talk to the embedded server.
- **The `opencode` CLI binary, on `PATH`** — the SDK package does not bundle a server binary; `createOpencode()` spawns the `opencode` executable itself (`opencode serve --hostname=... --port=...`, via `cross-spawn`) and talks to it over HTTP. If `opencode` is not on `PATH`, spawning the embedded server fails at first use — the first PM/specialist agent spawn or one-shot call under `AGENT_RUNTIME=opencode` — not at boot.

The CLI version must match the SDK. The Docker images install it automatically from the `@opencode-ai/sdk` pin in `package.json` (`Dockerfile.dev` / `Dockerfile.prod`: `npm i -g opencode-ai@"$(node -p "require('./package.json').dependencies['@opencode-ai/sdk']")"`), so there is a single source of truth and no hardcoded version to keep in sync. For a local (non-container) install, install the matching version yourself — `npm install -g opencode-ai@<same version as @opencode-ai/sdk>` — or the official install script (`curl -fsSL https://opencode.ai/install | bash`); check opencode's own docs for the currently recommended method.

The embedded server is started lazily, once per process, on an ephemeral port (`port: 0`), and reused for the rest of the process's lifetime — it is not restarted per task or per agent (`getOpencodeClient()` in `src/runtime/opencode/server.ts`). It is terminated on process shutdown (SIGINT/SIGTERM → `closeOpencodeBridge()`), so a dev-server reload doesn't leak orphaned `opencode serve` children.

## Provider/auth config — `OPENCODE_CONFIG_PATH`

opencode resolves its own provider and auth configuration (API keys, provider endpoints, model aliases, etc.) from its standard config locations, one of which is the file at `OPENCODE_CONFIG_PATH`. Archie's TypeScript code never reads this variable itself — it is plain environment passed through to the spawned `opencode` process, which reads it directly. Point it at a JSON config file describing your providers, e.g.:

```bash
OPENCODE_CONFIG_PATH=/app/opencode.json
```

See opencode's own configuration docs for that file's schema. Archie only needs the resulting `provider/model` ids to line up with what you set in `ARCHIE_OPENCODE_MODEL_*` below — opencode config and Archie's model-routing env are two independent things that must agree on the same provider/model strings.

## Model routing — `ARCHIE_OPENCODE_MODEL_*`

Model routing is **per agent, per turn**. Each agent runs on its own tier — the same tier it would use under the Claude runtime (PM → `opus`, specialists and plugin agents → `sonnet`, unless an agent definition pins its own `model`) — rather than a single server-wide model. `resolveAgentOpencodeModel(def)` (`src/runtime/opencode/model.ts`) derives the agent's logical tier and maps it to an opencode `{ providerID, modelID }`, which the runtime sends as `body.model` on every `promptAsync` call. The server-global `config.model` (set once at boot from the `default` route) is only the fallback used when a turn omits `body.model`.

The logical-name → `provider/model` mapping (`resolveOpencodeModel()`) resolves in this order:

1. **Passthrough** — if the logical name itself contains a `/` (e.g. an agent configured with `model: 'anthropic/claude-opus-4-8'` directly), it's split on the first `/` into `providerID`/`modelID` and used as-is; no env lookup.
2. **Per-tier env** — otherwise, `ARCHIE_OPENCODE_MODEL_<UPPER(name)>` (e.g. `ARCHIE_OPENCODE_MODEL_SONNET` for `'sonnet'`). The value must be a `provider/model` string. (The Claude-only `[1m]` 1M-context suffix on a tier name is stripped before lookup.)
3. **Default env** — `ARCHIE_OPENCODE_MODEL_DEFAULT`, same format, used when no per-tier var matched.
4. **Throw** — if neither resolves, it throws an error naming exactly which env var to set; it never silently guesses. (On an agent turn this is caught and the turn falls back to the server default rather than failing.)

So to run the PM on a capable model and specialists on a cheaper/faster one, set the tiers to different routes, e.g.:

```bash
ARCHIE_OPENCODE_MODEL_DEFAULT=anthropic/claude-haiku-4-5
ARCHIE_OPENCODE_MODEL_OPUS=anthropic/claude-opus-4-8      # PM
ARCHIE_OPENCODE_MODEL_SONNET=anthropic/claude-sonnet-5    # specialists
```

The PM's turns run on `claude-opus-4-8`, a specialist's on `claude-sonnet-5`, and any tier with no per-tier var of its own (e.g. a one-shot requesting `'haiku'` with no `ARCHIE_OPENCODE_MODEL_HAIKU`) falls back to `_DEFAULT`. Note that configured repo agents may pin `model: opus` in their plugin frontmatter — those resolve to the OPUS tier, so to see PM/specialist divergence a specialist must be on a non-OPUS tier. The message footer shows each agent's actual route, deduped, as the team grows.

Picking a capable model for the PM matters: opencode PM orchestration (multi-step delegation, edit-mode requests, MR creation) needs a strong model; weaker models may fail to parse the request or mis-drive the flow.

Context window: the opencode runtime uses whatever context window the configured model provides — Archie sets no context flag (unlike the Claude runtime's `[1m]` beta). For large tasks, choose a 1M-context model (e.g. `openrouter/z-ai/glm-5.2`) for the tiers that need it. `capabilities.oneMillionContext` is `true` for opencode on that basis, but it's ultimately a property of the model you route to.

## Boot-time validation

`assertBackendConfig()` (`src/system/backends.ts`), called once early in boot, fails fast if `AGENT_RUNTIME=opencode` is set with no model route configured at all — that is, no environment variable whose name starts with `ARCHIE_OPENCODE_MODEL_` is present. The thrown error names both `ARCHIE_OPENCODE_MODEL_DEFAULT` and the per-tier alternative, so a misconfigured deployment fails at boot with an actionable message. This check only requires *at least one* such var; a logical name with neither its own per-tier var nor `_DEFAULT` still throws later at resolution time. In practice set `ARCHIE_OPENCODE_MODEL_DEFAULT` — the embedded server resolves the `default` route for `config.model` at boot, so it is effectively required.

The resolved backend matrix (`repoHost`/`runtime`) is logged at boot and exposed on `GET /health`, so `runtime=opencode` is observable without reading environment variables directly.

## How the runtime works

opencode's `session.prompt` is agentic (it runs an agent with tools), not a bare text completion, so Archie's tools have to be exposed to it. The runtime does this with a hybrid model:

- **Built-in tools** (file read/edit, bash, webfetch) are opencode's own and do the file/shell work.
- **Archie's in-process control tools** run behind a **localhost HTTP bridge** (`src/runtime/opencode/bridge/`) — a loopback listener with a bearer token and a `sessionId → {task, agent}` registry, reached from opencode via a generated plugin dropped into `<serverCwd>/.opencode/plugins/`. This is what lets the out-of-process opencode agent call tools that are closures over the live in-memory `Task`. Bridged tools: `post_to_user` / `report_completion` / `request_edit_mode`, the repo-tools, the base agent-tools (`send_message_to_agent`, `log_finding`, `share_artifact`; all agents), `web_research` (all agents), and comms/orchestration/scheduling (PM only).
- **External domain MCP servers** (the plugins' HTTP/OAuth MCP servers) map to opencode's native `config.mcp`, with OAuth headers injected from the orchestrator. A per-turn `body.tools` denylist scopes each agent to the external servers it declared.

Turn mechanics: a turn is fired with `session.promptAsync` (returns immediately) and completes on the SSE `session.idle` event via an in-process completion registry — so a long agentic turn can't trip the HTTP client's headers timeout the way a held-open `session.prompt` would. A stale session (`NotFoundError`) is reset and retried once; a transient turn error is routed into the task's bounded recovery loop rather than hanging the task `in_progress`.

Read-only enforcement: a plugin `tool.execute.before` guard blocks opencode's built-in write/edit/bash tools for non-edit sessions (querying the bridge's bearer-gated `/policy` per call, fail-closed), and the bridge rejects write repo-tools for read-only sessions — matching the Claude runtime's `disallowedTools` list. A session is writable only when it is a repo agent in edit mode; the PM, plugin agents, and read-only repo agents cannot use built-in writes.

Prompt parity: agent prompts are shared across runtimes via per-runtime variables (`src/agents/prompt-runtime-vars.ts`) — tool names are lowercased (`Read` → `read`, etc.), the opencode prompts point at the native lowercase `skill` tool, and the Claude render is byte-identical.

Skills: opencode's `skill` tool discovers `SKILL.md` files by the **serve process's working directory at startup** (not per-session — a `query.directory` probe surfaced nothing). Since Archie runs ONE shared embedded server, skills are staged **globally**: at boot the runtime links the union of every agent's skill sources into `<serveRoot>/.opencode/skills/` (`runtime/opencode/skills.ts`), where `serveRoot` is a clean, `git init`-bounded dir under the workdir (`<workdir>/opencode-server`). The serve child runs with its cwd there — NOT the repo root — so opencode's discovery walk stops at that boundary and sees only the staged skills, not Archie's own `.claude/skills`. Every agent therefore sees every skill (global, unlike the Claude runtime's per-agent scoping); which skill to use is steered by each agent's prompt. Each `SKILL.md` must carry BOTH `name:` and `description:` frontmatter — opencode skips a skill missing `name:` (Claude derives it from the dir).

Commits: the agent commits via its built-in bash. The clone's local git identity is set to the bot at clone-creation time (`configureGitIdentity` in `setupSharedClone`), so commits carry the bot identity and satisfy host committer push-rules — set `GITLAB_BOT_EMAIL` to a verified email of the token account for a GitLab host that enforces committer verification.

## Known limitations

- **No OS sandbox.** Unlike the Claude runtime, the opencode runtime has no kernel-level sandbox: read-only mode is guard-enforced (the plugin `before` hook + bridge dispatch), not enforced by the OS, and agent bash/egress are unsandboxed. A firewall + bash sandbox for opencode is planned future work.
- **Skills are global, not per-agent.** Because one shared embedded server serves all agents and opencode discovers skills by the serve cwd, every opencode agent sees every staged skill (the Claude runtime scopes skills per agent via separate workspaces). Prompts steer each agent to its own domain skill. True per-agent scoping would require per-agent serve processes (dropping the shared singleton) — a deferred follow-up.
- **A staged `SKILL.md` needs a `name:` frontmatter field** to appear under opencode (it also requires `description:`). Skills that rely on Claude deriving the name from the directory (no `name:` in frontmatter) are silently skipped by opencode — fix the plugin's `SKILL.md`.
- **`web_research`** needs a `PERPLEXITY_API_KEY`; without it the tool is present but the research call fails.
