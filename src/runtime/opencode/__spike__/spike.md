# P2-B.1 Task-1 spike — findings

Date: 2026-07-09 · harness: `harness.ts` (run `npx tsx src/runtime/opencode/__spike__/harness.ts`, local opencode CLI + OpenRouter).
Result: **all six unknowns pinned; the hybrid bridge is feasible end-to-end.** A model call drove a plugin-registered custom tool whose `execute` fetched a localhost stub and returned its result; the turn completed.

## 1. Plugin placement + shape
- opencode loads plugins from `<serverCwd>/.opencode/plugins/*.ts` (server cwd = the process cwd that spawned `opencode serve`; the harness `process.chdir`s into a temp project dir).
- Plugin shape (TS, run in opencode's Bun runtime — its `@opencode-ai/plugin` import resolves THERE, not from Archie's node_modules):
  ```ts
  import { tool } from "@opencode-ai/plugin";
  export const SpikePlugin = async (ctx) => ({
    "tool.execute.before": async (input, output) => { /* ... */ },
    tool: {
      archie_ping: tool({ description, args: { msg: tool.schema.string() }, async execute(args, ctx) { /* ... */ } }),
    },
  });
  ```
- Plugin init `ctx` keys: `client, project, worktree, directory, experimental_workspace, serverUrl, $`.

## 2. Session id inside a custom tool (the Task-3 accessor)
- `execute(args, ctx)` → **`ctx.sessionID`** is the opencode session id (e.g. `ses_0b85eb497ffe…`).
- `tool.execute.before(input, output)` → `input = { tool, sessionID, callID }` (also carries the session id).
- Full `execute` ctx keys: `sessionID, abort, messageID, callID, extra, agent, messages, metadata, ask, directory, worktree` (`extra.model` has the full model descriptor; `agent` = the agent name, e.g. `"build"`; `ask` is the permission-ask fn).
→ **Task 3 plugin uses `ctx.sessionID`** in the bridge callback body.

## 3. Outbound fetch from the plugin
- `fetch("http://127.0.0.1:<port>/tool", { method:"POST", ... })` works from inside `execute`; the localhost stub received the POST and its JSON reply flowed back into the tool result. → the HTTP bridge is viable.

## 4. Guard hook / blocking (B.2 mechanism)
- `tool.execute.before` fires before `execute` and sees `input.tool` + `input.sessionID`. Throwing from it blocks the call. → B.2 read-only enforcement can gate `edit`/`bash`/write-ish tools here (in addition to config.permission).

## 5. Model-routing fix (the P2-A bug)
- **`config.model` (top-level, `"provider/model"`) IS honored** — the turn ran `providerID=openrouter modelID=anthropic/claude-haiku-4.5`, matching `config: { model: "openrouter/anthropic/claude-haiku-4.5" }`, with **no `model` in the prompt body**.
- P2-A passed `body.model` (per-prompt) and it was ignored (opencode used its default) — that path is a dead end. Use `config.model` instead.
- CAVEAT for multi-agent: the embedded server is one process; `config.model` is server-global. B.1 (PM-only) is fine with `config.model` = the PM route. Per-agent model routing (PM opus vs specialist sonnet on the same server) needs per-role `config.agent.<name>.model` + selecting `body.agent` — **verify in Task 4** (small); the default `build` agent worked here with config.model.

## 6. Permission-hang fix
- **`config.permission`** governs the gates. With `{ edit:'allow', bash:'allow', webfetch:'allow', external_directory:'allow' }` the turn completed with no hang (P2-A hung on `external_directory: ask`).
- B.1 (read-only investigation): allow reads + `external_directory: allow`. B.2 (RO enforcement): `edit:'deny'`, `bash:'deny'` (+ the before-hook guard) in read-only mode; allow in edit mode.

## Plan impact
- Task 3: plugin reads `ctx.sessionID`; env `ARCHIE_BRIDGE_URL`/`ARCHIE_BRIDGE_TOKEN` — confirm createOpencode forwards process env to the `opencode serve` child (it inherits the parent env by default via cross-spawn); the harness plugin read a compile-time constant, so Task 3 must verify env inheritance or bake the values into the generated plugin string.
- Task 4: set the embedded server `config.model` (resolved route) + `config.permission` (per RO/edit mode) instead of per-prompt `body.model`; drop `body.model`/`body.agent` unless per-agent routing needs `config.agent` + `body.agent`. Keep the single-arg prompt + abort signal.
- Bonus: baking `ARCHIE_BRIDGE_URL`/`TOKEN` directly into the generated plugin source (Task 3) sidesteps any env-forwarding question — simplest + robust.
