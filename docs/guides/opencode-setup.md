# opencode runtime setup guide

This guide covers running Archie's agent runtime on [opencode](https://opencode.ai) instead of the Claude Agent SDK, selected via `AGENT_RUNTIME=opencode`. It is a full runtime: the PM and specialist agents boot, create sessions, use tools (Archie's own plus opencode's built-ins), enforce read-only mode, route models per agent, and drive real end-to-end tasks (investigate → edit → commit → push → open a merge request, posting back to Slack/CLI). `AGENT_RUNTIME=claude` remains the default and is unaffected by anything in this guide.

## Overview

Setting `AGENT_RUNTIME=opencode` swaps the active `AgentRuntime` and `LlmOneShot` implementations from the Claude Agent SDK to an embedded opencode server (`src/runtime/opencode/`), resolved by `src/system/backends.ts` (see `docs/architecture/backends.md` for the full backend-resolution picture). Archie's own imports of the opencode SDK are confined to `src/runtime/opencode/`, mirroring the vendor-isolation pattern already used for the Claude SDK (`src/runtime/claude/sdk.ts`) and the GitHub/GitLab connectors.

## Installing opencode

Two separate things are required, and both matter:

- **The `@opencode-ai/sdk` npm package** — pinned in `package.json` and installed by `npm install`. This is the TypeScript client `src/runtime/opencode/embedded-server.ts` uses to spawn and talk to each serve child.
- **The `opencode` CLI binary, on `PATH`** — the SDK package does not bundle a server binary; `embedded-server.ts` spawns the `opencode` executable itself (`opencode serve --hostname=... --port=...`) and talks to it over HTTP. If `opencode` is not on `PATH`, spawning a serve child fails at first use — the first PM/specialist agent spawn or one-shot call under `AGENT_RUNTIME=opencode` — not at boot.

The CLI version must match the SDK. The Docker images install it automatically from the `@opencode-ai/sdk` pin in `package.json` (`Dockerfile.dev` / `Dockerfile.prod`: `npm i -g opencode-ai@"$(node -p "require('./package.json').dependencies['@opencode-ai/sdk']")"`), so there is a single source of truth and no hardcoded version to keep in sync. For a local (non-container) install, install the matching version yourself — `npm install -g opencode-ai@<same version as @opencode-ai/sdk>` — or the official install script (`curl -fsSL https://opencode.ai/install | bash`); check opencode's own docs for the currently recommended method.

Each spawned agent instance gets its own embedded `opencode serve` child on an ephemeral port (`port: 0`), keyed `${taskId}:${agentId}` (`getAgentServe()` in `src/runtime/opencode/serve-pool.ts`) — booted on demand and reused for that agent instance's turns, not one process-wide server shared by every agent. A shared bridge listener (`getBridge()`/`closeBridge()` in `src/runtime/opencode/server.ts`) and a small utility serve for one-shot LLM calls (`src/runtime/opencode/llm-one-shot.ts`) round out the process's opencode footprint. Everything is terminated on process shutdown (SIGINT/SIGTERM), so a dev-server reload doesn't leak orphaned `opencode serve` children.

## Provider/auth config — `OPENCODE_CONFIG_PATH`

opencode resolves its own provider and auth configuration (API keys, provider endpoints, model aliases, etc.) from its standard config locations, one of which is the file at `OPENCODE_CONFIG_PATH`. Archie's TypeScript code never reads this variable itself — it is plain environment passed through to the spawned `opencode` process, which reads it directly. Point it at a JSON config file describing your providers, e.g.:

```bash
OPENCODE_CONFIG_PATH=/app/opencode.json
```

See opencode's own configuration docs for that file's schema. Archie only needs the resulting `provider/model` ids to line up with what you set in `ARCHIE_OPENCODE_MODEL_*` below — opencode config and Archie's model-routing env are two independent things that must agree on the same provider/model strings.

## Model routing — `ARCHIE_OPENCODE_MODEL_*`

Model routing is **per agent, per serve child**. Each agent runs on its own tier — the same tier it would use under the Claude runtime (PM → `opus`, specialists and plugin agents → `sonnet`, unless an agent definition pins its own `model`) — rather than a single server-wide model. `resolveAgentOpencodeModel(def)` (`src/runtime/opencode/model.ts`) derives the agent's logical tier and maps it to an opencode `{ providerID, modelID }`, which becomes that agent's serve child's `config.model` at boot. There is no per-turn override to apply: since each agent instance owns its own child (keyed `${taskId}:${agentId}`), the child's model IS that agent's route from the moment it boots.

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

`assertBackendConfig()` (`src/system/backends.ts`), called once early in boot, fails fast if `AGENT_RUNTIME=opencode` is set with no model route configured at all — that is, no environment variable whose name starts with `ARCHIE_OPENCODE_MODEL_` is present. The thrown error names both `ARCHIE_OPENCODE_MODEL_DEFAULT` and the per-tier alternative, so a misconfigured deployment fails at boot with an actionable message. This check only requires *at least one* such var; a logical name with neither its own per-tier var nor `_DEFAULT` still throws later at resolution time. In practice set `ARCHIE_OPENCODE_MODEL_DEFAULT` — every agent's serve child resolves its own tier at boot, falling back to `_DEFAULT` when the tier has no route of its own, so it is effectively required.

The resolved backend matrix (`repoHost`/`runtime`) is logged at boot and exposed on `GET /health`, so `runtime=opencode` is observable without reading environment variables directly.

## How the runtime works

opencode's `session.prompt` is agentic (it runs an agent with tools), not a bare text completion, so Archie's tools have to be exposed to it. The runtime does this with a hybrid model:

- **Built-in tools** (file read/edit, bash, webfetch) are opencode's own and do the file/shell work.
- **Archie's in-process control tools** run behind a **localhost HTTP bridge** (`src/runtime/opencode/bridge/`) — one loopback listener shared by every agent's serve child, with a `sessionId → {task, agent}` registry and a per-child bearer token (minted per serve child, revoked when that child closes), reached from opencode via a generated plugin dropped into `<childCwd>/.opencode/plugins/`. This is what lets the out-of-process opencode agent call tools that are closures over the live in-memory `Task`. Bridged tools: `post_to_user` / `report_completion` / `request_edit_mode`, the repo-tools, the base agent-tools (`send_message_to_agent`, `log_finding`, `share_artifact`; all agents), `web_research` (all agents), and comms/orchestration/scheduling (PM only).
- **External domain MCP servers** (the plugins' HTTP/OAuth MCP servers) map to opencode's native `config.mcp`, with OAuth headers injected from the orchestrator. A per-turn `body.tools` denylist scopes each agent to the external servers it declared.

Turn mechanics: a turn is fired with `session.promptAsync` (returns immediately) and completes on the SSE `session.idle` event via an in-process completion registry — so a long agentic turn can't trip the HTTP client's headers timeout the way a held-open `session.prompt` would. A stale session (`NotFoundError`) is reset and retried once; a transient turn error is routed into the task's bounded recovery loop rather than hanging the task `in_progress`.

Read-only enforcement: a plugin `tool.execute.before` guard blocks opencode's built-in write/edit/bash tools for non-edit sessions (querying the bridge's bearer-gated `/policy` per call, fail-closed), and the bridge rejects write repo-tools for read-only sessions — matching the Claude runtime's `disallowedTools` list. A session is writable only when it is a repo agent in edit mode; the PM, plugin agents, and read-only repo agents cannot use built-in writes.

Prompt parity: agent prompts are shared across runtimes via per-runtime variables (`src/agents/prompt-runtime-vars.ts`) — tool names are lowercased (`Read` → `read`, etc.), the opencode prompts point at the native lowercase `skill` tool, and the Claude render is byte-identical.

Skills: opencode's `skill` tool discovers `SKILL.md` files by the serve process's working directory, and — verified live against CLI `1.17.16` (spike record: `runtime/opencode/__spike__/skills-refresh-spike.md`) — the discovered set (both the skill list AND each skill's content) is **frozen for that serve process's lifetime**: a re-stage after its startup is invisible to that same running child (even a fresh session doesn't refresh it). Archie sidesteps this by giving each agent instance its own serve child, keyed `${taskId}:${agentId}` (`runtime/opencode/serve-pool.ts`): at boot, that child stages ONLY its own agent's skill sources (`skillsPath` + `coreSkillsPath`) into `<childCwd>/.opencode/skills/` (`stageAgentSkills`, `runtime/opencode/skills.ts`). A repo agent's `childCwd` is its own clone (its git worktree already bounds discovery); a clone-less agent (PM, plugin agents) gets a clean, `git init`-bounded synthetic root under `<workdir>/opencode-server/<taskId>/<agentId>`. Either way opencode's discovery walk sees only that one agent's own staged skills — never another agent's, and never Archie's own `.claude/skills`. On a plugins push every live child is marked stale and recycled (closed + a fresh child spawned) at its next turn boundary — since staging happens at that fresh child's boot, the new skill set takes effect on the very next turn, no process restart required. This behavior is version-sensitive; re-verify the spike on CLI bumps. Each `SKILL.md` must carry BOTH `name:` and `description:` frontmatter — opencode skips a skill missing `name:` (Claude derives it from the dir).

Commits: the agent commits via its built-in bash. The clone's local git identity is set to the bot at clone-creation time (`configureGitIdentity` in `setupSharedClone`), so commits carry the bot identity and satisfy host committer push-rules — set `GITLAB_BOT_EMAIL` to a verified email of the token account for a GitLab host that enforces committer verification.

## Per-child OS sandbox (P3b)

Building on the per-agent serve topology above (each agent instance already gets its own `opencode serve` child), every child is also spawned inside a bubblewrap (`bwrap`) filesystem jail with its egress steered through a cooperative HTTP(S) proxy. This is on unconditionally under `AGENT_RUNTIME=opencode` — there is no separate opt-in flag — and layers on top of the child-per-agent design without changing anything you configure above.

**Filesystem jail.** Each child's mounts are derived from that agent's own `SandboxOptions` (the same object the Claude runtime uses for its bubblewrap/hook enforcement, `src/agents/sandbox.ts`): system dirs (`/usr /bin /lib /lib64 /etc /opt /sbin`) plus the agent's `allowReadPaths` are read-only; the child's `cwd` (its clone or synthetic root), its per-agent `HOME`, and the agent's `allowWritePaths` are read-write; and the agent's `denyWritePaths` are re-bound read-only after the read-write mounts, downgrading just that sub-path back to read-only. Hardening flags (`--die-with-parent --unshare-pid --unshare-ipc --unshare-uts`) are applied, but there is deliberately **no `--unshare-net`** — the child keeps the host network namespace so the loopback bridge callback and the SDK's HTTP/SSE connection keep working; egress is filtered cooperatively instead (below), not by a network namespace.

**Cooperative egress proxy.** Each child is forced (via `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env) through a per-process loopback proxy, authenticating with its own per-child credential that maps to a per-child host allowlist. Three parts of that allowlist are hardcoded and orchestrator-controlled — the model provider's host(s) (from a hardcoded provider map, keyed off the agent's resolved route), the repo host for repo agents (the configured GitLab base URL, or GitHub's fixed endpoints), and the trusted npm/Yarn registries for repo agents in edit mode only — and no plugin can widen them. Two more parts come from the agent's own frontmatter: this agent's declared MCP server hosts and any `allowedNetworkDomains`. Those are plugin-declared, and a plugins hot reload recycles children under the newly-declared allowlist — the same trust model the Claude runtime already uses (its sandbox likewise honors frontmatter network domains); a plugin that already controls an agent's tools and prompt declaring that agent's egress hosts adds no new authority.

**Honest boundary.** The filesystem jail is kernel-enforced by `bwrap`. The egress proxy is **cooperative and covers only the serve process's own outbound `fetch`** — the model-provider calls, `webfetch`, and remote-MCP traffic opencode itself makes, which honor the forced proxy env. It does **not** filter egress from `bash`-spawned subprocesses (`git`, `npm`, `curl`, …): opencode's `bash` tool doesn't forward the serve process's env to the commands it spawns, so those go to the network directly, unfiltered (a tracked follow-up injects the proxy via clone-local git config instead of env inheritance). And a deliberately malicious `bash` could always open a direct TCP connection regardless, since there's no network-namespace isolation; kernel-enforced egress (`--unshare-net`) is the larger tracked follow-up, not yet implemented.

**Platform gate.** On Linux, `bwrap` is mandatory: if it's missing or fails to spawn, the child boot fails closed and routes into task recovery rather than ever running a child unsandboxed. On macOS (dev), there's no `bwrap`; the runtime warns once and runs the child unwrapped — the pruned env and the egress proxy still apply even without the filesystem jail. The Docker images (`Dockerfile.dev`/`Dockerfile.prod`) already ship `bwrap` and `socat`, so no image changes were needed for this.

**Session-store isolation.** Each agent's child pins `HOME`/`XDG_DATA_HOME` to a per-agent directory under that task's serve root (`<workdir>/opencode-server/<taskId>/<agentId>/home`), instead of the real user's `~/.local/share/opencode`. This directory is removed at task teardown along with the rest of that task's serve state, so if you reopen a task after its serve root has been evicted, each agent's opencode sessions cold-start rather than resume — the existing stale-session recovery already handles that transparently.

**Environment pruning.** Each child's environment is built from scratch (a small base allowlist, the pinned `HOME`/`XDG_DATA_HOME`, the proxy vars, and only the API key for its own route's provider) rather than inherited from the orchestrator process — Slack, GitLab, and GitHub tokens no longer reach the child at all.

**No new config.** P3b adds zero new environment variables. Adding support for a new model provider's egress means editing the provider→host and provider→env-key maps in `src/runtime/opencode/child-sandbox.ts`, not adding a config knob.

## Known limitations

- **Egress is cooperative, not kernel-enforced — and only covers the serve process's own `fetch`.** The filesystem jail above is kernel-enforced, but there is no `--unshare-net`. The egress proxy filters the opencode server's own outbound traffic (model calls, `webfetch`, remote MCP) but not `bash`-spawned subprocesses (`git`/`npm`/`curl`), which don't inherit the proxy env; and a malicious `bash` could open a direct TCP connection regardless. Read-only mode itself is guard-enforced (the plugin `before` hook + bridge dispatch) independent of the filesystem jail.
- **Every child boot logs a couple of `egress DENY` warnings — this is expected.** The opencode CLI makes background calls to `models.dev` (model catalog) and a telemetry endpoint that the narrow allowlist intentionally denies; the CLI degrades gracefully (the model turn still completes) and the warn lines are not an error to chase. Only a failure of model *resolution* itself would indicate a real allowlist gap.
- **macOS runs unsandboxed.** The bubblewrap jail only runs on Linux; on macOS (dev) children run unwrapped, though the pruned env and egress proxy still apply. Linux/Docker fails closed instead: a missing/broken `bwrap` fails the child boot rather than running it unsandboxed.
- **Idle children accumulate memory over a long-lived task.** An idle `opencode serve` child is ~300 MB RSS; `OPENCODE_CHILD_IDLE_TTL` (default 15m) reaps a parked agent's child (context-free respawn — opencode persists sessions in its own process-global store), and `OPENCODE_CHILD_SOFT_CAP` (default 12) only emits a census warning when live children exceed it — it never queues or blocks a spawn, so a burst of concurrent agents can still transiently exceed the soft cap.
- **A staged `SKILL.md` needs a `name:` frontmatter field** to appear under opencode (it also requires `description:`). Skills that rely on Claude deriving the name from the directory (no `name:` in frontmatter) are silently skipped by opencode — fix the plugin's `SKILL.md`.
- **`web_research`** needs a `PERPLEXITY_API_KEY`; without it the tool is present but the research call fails.
