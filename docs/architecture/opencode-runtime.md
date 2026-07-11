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

> Read-only enforcement above is guard-enforced (the plugin `before` hook + bridge dispatch), independent of the OS sandbox described next — a compromised/buggy guard would still be caught by the per-child filesystem jail for writes, but the jail alone doesn't gate read-only vs. edit-mode, which stays this section's job.

## Per-child OS sandbox (P3b)

Building on P3a's one-serve-child-per-agent-instance topology, P3b wraps each child's spawn in a bubblewrap (`bwrap`) filesystem jail and steers its egress through a cooperative HTTP(S) proxy. All of it is assembled per child in `child-sandbox.ts` and `egress-proxy.ts`, and wired into the spawn path in `serve-pool.ts` (`bootChild`), `llm-one-shot.ts` (the utility serve), and `embedded-server.ts` (`startEmbeddedServer`'s `spawnOverride`/`env` params).

**Filesystem jail.** `buildChildSandboxProfile` (`child-sandbox.ts`) derives a `ChildSandboxProfile` from the agent's own `SandboxOptions` (`agent.sandbox`, the same object `src/agents/sandbox.ts` uses for the Claude runtime's bubblewrap/hook enforcement) plus P3b-specific paths, and `buildSandboxArgv` turns that profile into `bwrap` flags:

- System dirs (`/usr /bin /lib /lib64 /etc /opt /sbin`) are `--ro-bind`, plus a fresh `--tmpfs /tmp`, `--proc /proc`, `--dev /dev`.
- The agent's `SandboxOptions.allowReadPaths` are `--ro-bind`.
- The child's `cwd` (the repo clone for a repo agent, or the synthetic root for PM/plugin agents) and its per-agent `homeDir` are always `--bind` (rw), regardless of what the profile assembler also lists; `<cwd>/.opencode` is included in the rw set so skill staging and the bridge plugin file can be written there.
- `SandboxOptions.allowWritePaths` are added `--bind` (rw).
- `SandboxOptions.denyWritePaths` are re-bound `--ro-bind` **after** the rw binds — `bwrap` processes binds sequentially, so a deny path inside an already-rw'd region is downgraded back to read-only by the later bind. This mirrors the allow/deny non-overlap rule `src/agents/sandbox.ts`'s `buildSandboxConfig` already uses for the Claude runtime.
- Hardening flags: `--die-with-parent --unshare-pid --unshare-ipc --unshare-uts`.
- Deliberately **no `--unshare-net`** — the child keeps the host network namespace so loopback (the bridge callback, the SDK client's HTTP/SSE connection) keeps working. Egress is filtered cooperatively instead (below), not by a kernel-level network namespace.

Nonexistent bind sources are silently skipped (a clone or lib path can legitimately not exist on a given host/task); `cwd` and `homeDir` are guaranteed to exist on disk before the argv is built (the pool `mkdir`s them first), so they always bind.

**Cooperative egress proxy.** `egress-proxy.ts` runs one loopback CONNECT/HTTP proxy per process (a singleton, like the bridge listener). Each child gets its own randomly-generated Basic-auth credential (`mintCredential`, revoked on child close) tied to a per-child host allowlist, and is steered to the proxy by forcing `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and lowercase variants) in its pruned env; `NO_PROXY=127.0.0.1,localhost` keeps the loopback bridge/SSE traffic direct. The allowlist itself is assembled by `computeProfileSkeleton` from hardcoded, orchestrator-controlled sources — never plugin- or PM-settable, so a hot-reloaded plugin or a compromised orchestrator can't widen it:

- The model provider's host(s), from the hardcoded `PROVIDER_EGRESS_HOSTS` map (`{ openrouter: ['openrouter.ai'], anthropic: ['api.anthropic.com'] }`), keyed off the agent's resolved route — throws if the provider has no entry.
- The repo host, for repo agents only (`repoHostEgressDomains`: the `GITLAB_BASE_URL` hostname, or GitHub's fixed `github.com`/`api.github.com`/`codeload.github.com` endpoints).
- `TRUSTED_PACKAGE_REGISTRY_DOMAINS` (`registry.npmjs.org`, `registry.yarnpkg.com`), for repo agents in edit mode only — the same constant the Claude runtime's build sandbox already trusts.
- Hosts of the MCP servers this agent's own frontmatter declares (not the global union of every plugin's MCP servers).
- `def.allowedNetworkDomains` from the agent's frontmatter.

`hostAllowed` matches an allowlist entry as an exact host or a dot-suffix subdomain, with bare entries permitting ports 443/80 only (an explicit `host:port` entry is required for anything else). Denials are logged with `{taskId, agentId, host}` only — never the credential.

**Honest boundary caveat.** The filesystem jail is kernel-enforced by `bwrap` — a write outside the rw binds or a read outside the ro/rw binds fails at the kernel, not by convention. The egress proxy is **cooperative**: it works because honest tooling (Bun's `fetch`, `npm`, `curl`, `git`) reads and honors the forced proxy env vars, so normal traffic is filtered, but a deliberately malicious `bash` command inside the jail could still open a direct TCP socket and bypass the proxy entirely, since there is no `--unshare-net`. Kernel-enforced egress (adding `--unshare-net` plus a veth/user-mode network stack so loopback still works) is a tracked follow-up, not yet implemented.

**Platform gate.** On Linux, `bwrap` is **mandatory and fail-closed**: `wrapServeCommand` probes for the `bwrap` binary once (cached) and throws if it's missing or unusable, which fails the child's boot and routes into the pool's boot-failure path → task recovery — a serve child is never spawned unsandboxed on a non-darwin host. On macOS (dev), there is no `bwrap`; `wrapServeCommand` warns once (`opencode children run UNSANDBOXED on darwin`) and runs the plain `opencode serve` command unwrapped — but the pruned env and the egress proxy still apply even without the filesystem jail.

**Per-agent session-store isolation.** Each agent instance's child boots with `HOME` and `XDG_DATA_HOME` both pinned to `agentHomeDir(taskId, agentId)` — `<workdir>/opencode-server/<taskId>/<agentId>/home` — instead of the real user's `~/.local/share/opencode`. This dir is created before the child spawns (`buildSandboxArgv` silently skips a nonexistent bind source, so a missing homeDir would otherwise boot the child with no writable `HOME` at all) and lives under the task's serve root, so P3a's `evictTask` removes it at task teardown along with the rest of that task's serve state. Consequence: a task reopened after its serve root was evicted gets a fresh, empty session store for each agent — its opencode sessions cold-start rather than resume — which the runtime's existing stale-session (`NotFoundError`) recovery already handles as a reset-and-retry.

**Environment pruning.** `buildChildEnv` composes each child's env from scratch rather than inheriting the orchestrator's `process.env` — `startEmbeddedServer` uses the P3b-built env **verbatim**, never spread with `process.env`, specifically so this pruning can't be silently undone. The child gets: a small base allowlist (`PATH`, `TERM`, `LANG`, `TZ`, plus any `LC_*` vars), the pinned `HOME`/`XDG_DATA_HOME`, the forced proxy vars, and — from the hardcoded `PROVIDER_ENV_KEYS` map — only the API key for the route's own provider (e.g. `OPENROUTER_API_KEY` for an `openrouter` route). Orchestrator secrets that used to be ambiently inherited — Slack tokens, `GITLAB_*`/`GITHUB_*` tokens — no longer reach the child process at all.

**No new env keys.** P3b introduces zero new Archie-level environment variables; the sandbox is on unconditionally wherever `AGENT_RUNTIME=opencode` runs (gated only by the existing platform check, not a config flag). Adding a new model provider means editing `PROVIDER_EGRESS_HOSTS` and `PROVIDER_ENV_KEYS` in `child-sandbox.ts`, not adding an env knob.

**No Docker image changes.** `bwrap` and `socat` (used for the loopback bridge in the container) already ship in `Dockerfile.dev`/`Dockerfile.prod`; P3b is pure application code on top of an unchanged image.

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
| `child-sandbox.ts` | Pure bwrap-argv builder, profile fingerprint, platform-gated spawn wrapper, provider/env maps, per-agent home dir (P3b). |
| `egress-proxy.ts` | The loopback cooperative CONNECT/HTTP egress proxy: per-child credentials, host allowlist matching (P3b). |

## Known limitations / follow-ups

- **Egress is cooperative, not kernel-enforced** — the per-child bwrap filesystem jail (P3b) is kernel-enforced, but there is deliberately no `--unshare-net`; a malicious `bash` inside the jail could still open a direct TCP connection bypassing the proxy. Kernel-enforced egress (`--unshare-net` + a loopback-preserving network setup) is tracked follow-up work.
- **macOS runs unsandboxed** — the bwrap jail is Linux-only; on darwin (dev) children run unwrapped (env pruning + the egress proxy still apply). Linux/Docker is fail-closed: a missing/broken `bwrap` fails the child boot rather than running unsandboxed.
- **A reopened task cold-starts opencode sessions** — the per-agent session store lives under the task's serve root and is removed by `evictTask`, so a task reopened after teardown gets a fresh, empty opencode session store per agent (existing `NotFoundError` recovery handles it, but there's no history to resume).
- **`backgroundTasks` unwired** — opencode subtasks aren't tracked into busy/idle accounting.
- **PM orchestration needs a capable model** — weaker models mis-drive multi-step flows (glm-5.2 works well).
- **Same-task agents sharing one clone** — when two agents share a single clone cwd, the second agent's serve child runs in its own synthetic root instead of the clone (so its skills + bridge plugin stay isolated).
