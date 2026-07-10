# opencode agent runtime — architecture

How Archie runs its agents on [opencode](https://opencode.ai) instead of the Claude Agent SDK, selected by `AGENT_RUNTIME=opencode`. This document explains the internals — the embedded server, the tool bridge, read-only enforcement, the turn model, model routing, skills, and external MCP. For setup/config (env vars, installing the CLI) see `docs/guides/opencode-setup.md`; for the backend-seam resolution see `docs/architecture/backends.md`.

All opencode/vendor code is confined to `src/runtime/opencode/`, behind the `AgentRuntime` port. `AGENT_RUNTIME=claude` remains the default and is unaffected.

## Why this shape

opencode is not an in-process SDK. `@opencode-ai/sdk` starts a **separate `opencode serve` child process** and talks to it over HTTP + SSE. And `session.prompt` is **agentic** — opencode runs an agent with its own built-in tools (file read/edit, bash, webfetch), not a bare text completion.

Two consequences drive the whole design:

1. **Archie's own tools are closures over the live in-memory `Task`/`Agent`** (`post_to_user`, `report_completion`, repo-tools, …). An out-of-process opencode child cannot call them directly. → they are exposed through an in-process **HTTP bridge** that a generated opencode **plugin** calls back into.
2. **opencode's built-in tools do the file/shell work** — so Archie does not reimplement them; it only adds its control/orchestration tools and *gates* the built-ins for read-only sessions.

```
                          Archie process (Node)
  ┌───────────────────────────────────────────────────────────────┐
  │  OpencodeRuntime.spawn(agent, task)                             │
  │     │  per turn: getAgentServe(agent, task) → serve-pool.ts     │
  │     │            session.promptAsync({ model, system, tools })  │
  │     ▼                                                           │
  │  serve-pool.ts — ONE `opencode serve` child PER agent instance,  │
  │  keyed `${taskId}:${agentId}` (embedded-server.ts spawns each)   │
  │     ▼                                                           │
  │  Bridge (loopback HTTP + bearer token) — ONE listener, shared    │
  │   • SessionRegistry: sessionId → { task, agent, readOnly }      │
  │   • GET  /tools    → tool manifest                              │
  │   • POST /tool     → dispatch to in-process handlers            │
  │   • GET  /policy   → { readOnly, blockedTools, editModeApplies }│
  │     ▲       per-child bridge token       SSE per child           │
  │     │                    │                                      │
  └─────┼────────────────────┼──────────────────────────────────────┘
        │ HTTP (localhost)   │ HTTP/SSE
        │                    ▼
  ┌─────┴──────────────────────┐  ┌─────────────────────────────┐
  │ opencode serve (agent A)    │  │ opencode serve (agent B)     │  ...
  │  cwd = clone (repo agent)   │  │  cwd = synthetic root (PM/   │
  │        or synthetic root    │  │        plugin agent)         │
  │  .opencode/skills/: THIS     │  │  .opencode/skills/: THIS      │
  │    agent's own skills only  │  │    agent's own skills only   │
  │  generated bridge plugin     │  │  generated bridge plugin      │
  │  config.model: THIS agent's │  │  config.model: THIS agent's  │
  │    resolved route            │  │    resolved route             │
  │  config.mcp: external MCP    │  │  config.mcp: external MCP     │
  └─────────────────────────────┘  └─────────────────────────────┘
```

## Per-agent serve children (`serve-pool.ts`, `embedded-server.ts`)

Each spawned `Agent` gets its own `opencode serve` child, keyed `${taskId}:${agentId}` (`getAgentServe` in `serve-pool.ts`). On first acquire for a key it:

1. Places the child's cwd: a repo agent's own clone (skills staged alongside, excluded from commits via `.git/info/exclude`), or a synthetic root at `<workdir>/opencode-server/<taskId>/<agentId>` for clone-less agents (PM, plugin agents) — `prepareServeRoot` (`mkdir` + `git init`, so opencode's upward skill-discovery walk stops at this root).
2. Stages ONLY that agent's own skills (`skillsPath` + `coreSkillsPath`) into `<cwd>/.opencode/skills` (`stageAgentSkills`, see Skills).
3. Mints a bridge token scoped to this child (`bridge.mintChildToken`) and writes the generated bridge plugin into `<cwd>/.opencode/plugins`.
4. Resolves this agent's model route and spawns `opencode serve` with `config.model` set to it (its own `config.mcp` too) — see Model routing.
5. Starts a per-child SSE event consumer.

Children boot on demand, are **reused** for later turns from the same agent instance, are **recycled** at the next turn boundary when marked stale (a plugins push, or a repo agent's clone moving path on a RO→RW mode transition), are **reaped** when their agent idles past `OPENCODE_CHILD_IDLE_TTL` (default 15m — safe because opencode sessions persist in its own process-global store, so a reap-then-respawn resumes context-free), and are **evicted** (their synthetic root removed) at task teardown. `OPENCODE_CHILD_SOFT_CAP` (default 12) only emits a census warning when live children exceed it — it never queues or blocks a spawn. A measured idle `opencode serve` child is ~300 MB RSS, so lifecycle bounds (idle reap, per-task eviction) matter for VM memory budget as task/agent counts grow.

**Manual spawn (`embedded-server.ts`).** The SDK's `createOpencode` spawns the serve child in the *current process cwd* and offers no way to change it — but skill discovery keys off that cwd, and Archie's process cwd is the repo root (with the repo's own dev skills). So `embedded-server.ts` reproduces the SDK's spawn faithfully — `opencode serve --hostname --port=0`, config passed via the `OPENCODE_CONFIG_CONTENT` env var, the listening URL parsed from the `opencode server listening on <url>` stdout line — and adds the one missing piece: an explicit **`cwd`**. It then connects with `createOpencodeClient({ baseUrl })`, and exposes `onExit` so the pool can eagerly evict a handle whose child crashed.

**The bridge listener itself remains a process singleton** (`getBridge()`/`closeBridge()` in `server.ts`) — ONE loopback listener + `SessionRegistry` shared by every per-agent child; each child gets its own bearer token via `bridge.mintChildToken`, revoked when its child closes. The `LlmOneShot` path (`llm-one-shot.ts`) runs its own tiny utility serve outside the pool entirely — no skills, no bridge plugin, no MCP, since one-shots never call tools.

**Lifecycle.** `closeServePool()` + `closeBridge()` + `closeOneShotServe()` (wired into `index.ts`'s SIGINT/SIGTERM `shutdown`) close every resolved child, the bridge listener, and the one-shot utility serve — so a dev reload doesn't leak orphaned `opencode serve` children. A `shuttingDown` guard on the pool covers the shutdown-during-first-boot race (a boot that resolves after teardown closes its child instead of re-establishing it).

## The tool bridge (`bridge/`)

A loopback-only HTTP server (`startBridgeServer`) with a bearer token and a `SessionRegistry` mapping each opencode `sessionId → { task, agent, readOnly }`. The generated plugin bakes in the bridge URL + token.

- **`GET /tools`** — the tool manifest (names + arg schemas). The generated plugin fetches this at load and registers one opencode custom tool per entry.
- **`POST /tool`** — dispatch. The plugin's `tool.execute` forwards `{ sessionId, tool, args }`; the bridge resolves the session's `{ task, agent }` and calls the in-process handler. Dispatch is a Map keyed by tool name (never a plain object, so a crafted tool name like `constructor` can't walk the prototype chain to reach live state); body parsing rejects non-objects (400) and caps at 1 MiB (413).
- **`GET /policy?sessionId=`** — read-only policy for the plugin guard (see Read-only enforcement).

**Arg-schema fidelity.** The bridge encodes each tool's full (possibly nested) zod schema into the manifest, and the generated plugin rebuilds a faithful zod schema — nested objects/arrays + field descriptions — rather than a bare `any`. Without this a structured arg (e.g. `spawn_repo_agent`'s `repos: [{ github, … }]`) reached the model shapeless and it guessed wrong.

### Tool surface

- **opencode built-ins** (`read`, `edit`, `bash`, `webfetch`, `skill`, …) — opencode's own; do the file/shell/skill work.
- **Bridged in-process tools** (`bridge/server.ts` `buildSessionHandlers`):
  - Control (all agents): `post_to_user`, `report_completion`, `request_edit_mode`.
  - Base inter-agent (all agents): `send_message_to_agent`, `log_finding`, `share_artifact`.
  - `web_research` (all agents) — folds the budget gate + persistence + external-content defense-tagging into one handler.
  - Repo tools (repo agents) — `fetch`, `create_branch`, `push_branch`, `create_pull_request`, review/PR tools, etc.
  - Comms / orchestration / scheduling (**PM only**): `find_slack_user`, `launch_task`, `spawn_repo_agent`, `set_reminder`, … The `/tools` manifest is not session-scoped, so PM-only enforcement happens at *dispatch*: a non-PM session's handler map simply lacks these keys, so a non-PM calling one hits "unknown tool (not permitted)".

The bridged control-tool handlers are the same functions the Claude MCP servers use (extracted in `agents/tools.ts`), so behaviour is identical across runtimes. Opencode-specific concerns (e.g. double-post dedup) live in the bridge's handler wrappers, never in the shared handlers or the core `Agent`.

## The turn model (`runtime.ts`, `events.ts`, `turn-completion.ts`)

A turn is fired with **`session.promptAsync`**, which returns immediately (HTTP 204). The turn's completion is the SSE **`session.idle`** event, delivered through an in-process **turn-completion registry** — NOT the HTTP response. (The blocking `session.prompt` held one HTTP request open for the whole agentic turn, which tripped undici's ~5-minute headers timeout on long turns.)

- One SSE consumer **per serve child** (`events.ts`, started by `serve-pool.ts` when a child boots) subscribes to that child's `client.event.subscribe().stream`, filters events by registered `sessionID`, and drives: `message.part.updated` (tool parts) → `task.noteActivity` (the status line); `session.idle` → resolve the turn with the streamed text; `session.error` → reject. Routing keys off the shared `SessionRegistry`, so N concurrent consumers (one per live child) coexist with no cross-talk.
- **Session not-found** (`res.error.name === "NotFoundError"`, `data.message` "Session not found") → reset the stored id, create a fresh session, retry **once**. Kills the stale-id hot-loop.
- **Transient (non-not-found) errors** → routed into the task's bounded recovery loop by marking the agent inactive (`updateAgentState(def.id, false)`) — mirroring the Claude runtime — rather than leaving the task hung `in_progress`.

## Read-only enforcement (`bridge/plugin-source.ts`, `bridge/server.ts`)

opencode's built-in write/edit/bash tools have **no per-session permission surface** — the server-wide `config.permission` can't gate them per session. So enforcement is two layers:

1. **Plugin `tool.execute.before` guard.** For a read-only session it throws before the built-in runs. It queries `GET /policy?sessionId=` on **every** call (no caching — the edit-mode approval flow resumes the same opencode `sessionID` with `readOnly` flipped, and the guard must observe the flip on the next call). It **fails closed**: any non-authoritative `/policy` result blocks the write set (`RO_BUILTIN_BLOCK` = edit/write/bash/patch/multiedit/apply_patch). Reads are never in that set, so they stay usable.
2. **Bridge `/tool` dispatch** rejects the write repo-tools (`WRITE_REPO_TOOLS`, byte-for-byte the Claude `disallowedTools` RO list) for a read-only session before dispatch.

**Who is read-only:** `readOnly = !(repo && repo.editAllowed)`. Only an **edit-mode repo agent** is writable. The PM, plugin agents, and read-only repo agents cannot use built-in writes — parity with the Claude runtime denying PM/plugin agents Bash/Edit/Write.

**`editModeApplies`.** `/policy` also returns whether edit-mode approval could ever make this session writable (i.e. it's a repo agent). The plugin's block message uses it: a read-only *repo* agent is told to request edit mode; a non-repo agent (PM/plugin) is told edit mode won't grant command execution — so a weaker model stops chasing edit mode to run a command (a dead-end that only re-blocks).

> No OS sandbox. Unlike the Claude runtime (bubblewrap), read-only here is guard-enforced, not kernel-enforced; agent bash/egress are unsandboxed. A firewall + bash sandbox is planned future work.

## Model routing (`model.ts`, `runtime.ts`)

Routing is **per agent, per child**. Each agent's serve child boots with `config.model` set to that agent's own resolved route — `resolveAgentOpencodeModel(def)` (`resolveAgentModel(def)`, the Claude runtime's alias: PM → `opus`, others → `sonnet`, or `def.model`) → strip the Claude-only `[1m]` suffix → `resolveOpencodeModel(alias)` → the `ARCHIE_OPENCODE_MODEL_<TIER>` route, falling back to `ARCHIE_OPENCODE_MODEL_DEFAULT` if the tier has no route of its own. There is no per-turn `body.model` override: since each agent instance owns its own child, the child's boot-time `config.model` already IS that agent's route, so a turn never needs to override it.

## Skills (`skills.ts`)

opencode has a native `skill` tool that discovers `SKILL.md` files by the **serve process's working directory at startup** — NOT per-session (`query.directory` does not affect skill discovery). Since each agent instance has its own serve child, skills are staged **per agent**: on boot, `stageAgentSkills` links ONLY that agent's own `skillsPath` + `coreSkillsPath` (plugin source first, so it shadows a core skill of the same name) into `<cwd>/.opencode/skills`, reusing the dependency-free `agents/skill-linking.ts`. Because the child's cwd is either the agent's own clone or a clean, git-bounded synthetic root, opencode sees only that agent's own staged skills — never another agent's, and never the repo's own `.claude/skills`.

This gives the opencode runtime the same per-agent skill scoping as the Claude runtime (which scopes skills per-agent via separate workspaces) — an agent's prompt no longer has to steer it away from skills that belong to a different agent. A skill push from a plugins refresh marks every live child stale (`markAllServesStale`), so each child re-stages fresh skills the next time it recycles at a turn boundary; because staging happens at child **boot** (not live, mid-process), the new skill set is visible on that very next turn — no process restart is needed. A `SKILL.md` must carry both `name:` and `description:` frontmatter — opencode skips one missing `name:` (Claude derives it from the directory).

## External MCP (`mcp-config.ts`, `tool-allowlist.ts`)

Plugin-domain MCP servers (HTTP/OAuth) map to opencode's native `config.mcp` (http/sse → remote, stdio → local; OAuth `Authorization` headers injected from the orchestrator), set once at server boot. Per turn, `body.tools` is a **denylist overlay** (unlisted tools stay ON, MCP tools are named `<server>_<tool>`), so each agent is scoped to the external servers it declared by *disabling* the others via a `<server>_*` glob.

## Prompt parity (`agents/prompt-runtime-vars.ts`)

Agent prompts are shared across runtimes; per-runtime `{{VAR}}` values adapt them. Tool names are lowercased (`Read` → `read`); the `Skill`-tool clauses point at opencode's lowercase `skill` tool; a PM note explains opencode has no command execution and that edit mode won't grant it. The Claude render is byte-for-byte identical (regression-tested).

## Git identity

The opencode agent commits via its built-in `bash`. `configureGitIdentity` is folded into `setupSharedClone`, so the clone's local committer identity is the bot **before** the clone is usable — a commit can't precede it and fall back to the host's global `~/.gitconfig`. (Set `GITLAB_BOT_EMAIL` to a verified email of the token account for a GitLab host that enforces committer verification.)

## Capabilities (`ports/capabilities.ts`)

`OPENCODE_RUNTIME_CAPABILITIES` is **declarative** (it documents parity and degrades gracefully) — nothing branches on it yet. Current: `skills: true`, `oneMillionContext: true` (a property of the configured model, e.g. glm-5.2 — Archie sets no context flag), `osSandbox: false`, `effort: false` (opencode has no per-turn reasoning-effort knob), `backgroundTasks: false` (opencode has subtasks, but the runtime doesn't yet track them into busy/idle accounting).

## File map

| File | Responsibility |
|------|----------------|
| `server.ts` | Shared process-singletons: bridge listener (`getBridge`/`closeBridge`), `sharedRegistry`, `concatPromptText`. |
| `serve-pool.ts` | Per-agent-instance serve pool: boot/reuse/recycle/reap/evict, keyed `${taskId}:${agentId}`. |
| `embedded-server.ts` | Manual `opencode serve` spawn with a controlled cwd + `createOpencodeClient`; serve-root prep; `SERVE_PERMISSION`. |
| `runtime.ts` | `OpencodeRuntime.spawn` — per-turn loop, `getAgentServe` acquire, `body` build, session recovery, abort, capabilities. |
| `events.ts` | Per-serve-child SSE consumer → status activity, turn completion, error. |
| `turn-completion.ts` | In-process registry: `waitForTurn` / `completeTurn` / `failTurn` / `cancelTurn`. |
| `model.ts` | `resolveOpencodeModel`, `resolveAgentOpencodeModel`, footer route helpers. |
| `skills.ts` | Stage one agent's own skills into its serve child's cwd (`stageAgentSkills`); `excludeOpencodeFromGit`. |
| `mcp-config.ts` | Root `.mcp.json` → opencode `config.mcp` (+ OAuth headers). |
| `tool-allowlist.ts` | Per-turn `body.tools` denylist scoping. |
| `llm-one-shot.ts` | The `LlmOneShot` (title/memory) path on its own utility serve, outside the per-agent pool. |
| `bridge/server.ts` | Loopback bridge: `/tools`, `/tool` dispatch, `/policy`; session handlers; RO/PM gating; per-child token mint/revoke. |
| `bridge/plugin-source.ts` | Generated opencode plugin (registers tools, forwards to `/tool`, RO `before` guard). |
| `bridge/registry.ts` | `SessionRegistry` (`sessionId → {task, agent, readOnly}`). |
| `agents/skill-linking.ts` | Dependency-free `linkAgentSkills` (shared with the Claude spawn path). |

## Known limitations / follow-ups

- **No OS sandbox** — RO is guard-enforced; bash/egress unsandboxed (P3b, per-child bubblewrap + egress proxy, is planned follow-up work).
- **`backgroundTasks` unwired** — opencode subtasks aren't tracked into busy/idle accounting.
- **PM orchestration needs a capable model** — weaker models mis-drive multi-step flows (glm-5.2 works well).
- **Same-task agents sharing one clone** — when two agents share a single clone cwd, the second agent's serve child runs in its own synthetic root instead of the clone (so its skills + bridge plugin stay isolated); candidate for a real per-child config dir in P3b.
