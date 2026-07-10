# B.3 Task-0 spike — opencode config.mcp + per-turn tool filtering (findings)

Run live: `npx tsx --env-file=.env src/runtime/opencode/__spike__/b3-mcp-spike.ts`
Probe server: `@modelcontextprotocol/server-everything` via `config.mcp.everything = { type:'local', command:['npx','-y',...] }`. Model observed: `openrouter/z-ai/glm-4.5` (opencode config behavior is model-independent; findings hold for any model).

## Findings (each confirmed live)

1. **`config.mcp` connects + surfaces tools.** With `config.mcp.everything` set, a prompt turn called the server's `echo` tool successfully (no error). So the T1 premise (translate `def.mcpServers` → `config.mcp` and opencode owns the connection) is valid.

2. **Tool-naming scheme = `<server>_<tool>`.** The MCP tool call arrived on the event stream as `part.tool === "everything_echo"` (server name `everything` + `_` + tool `echo`). → the `body.tools` allowlist keys and any name-matching use this form. A `<server>*` wildcard also works (see 3).

3. **`body.tools` gates MCP tools — both exact and wildcard.**
   - `{ everything_echo: false }` → echo NOT called (gated). ✅
   - `{ 'everything*': false }` → echo NOT called (gated). ✅ **Wildcard supported.**

4. **Semantics = DENYLIST overlay (unlisted tools default ON).** `{ everything_echo: true }` (enable only echo) left the built-in `read` tool fully working (called 3×). So `body.tools` does NOT act as a strict allowlist that disables everything unlisted — explicit `false` disables a tool; everything not mentioned stays enabled (built-ins, bridged custom tools, other MCP servers).

## Consequence for T2 (per-agent external-MCP scoping)

To restrict an agent to only its declared external servers, **disable the OTHER external servers**, do not "enable mine":

```
buildToolAllowlist(agent):
  declared = Object.keys(agent.def.mcpServers ?? {})          // this agent's servers
  all      = Object.keys(getRootMcpConfig().servers ?? {})    // the union (T1 source)
  return { for each s in all where s ∉ declared: `${s}*`: false }
```

This leaves the agent's own external servers, all built-ins, and all bridged custom tools ON (unlisted → on), and disables every other agent's external servers. Wildcard `${s}*` is confirmed. If `all === declared` (or no external servers), the map is `{}` (omit `body.tools`).

Bridged custom tools (post_to_user, web_research, comms/orch/sched) are NOT scoped here — they stay on via the unlisted-default-on semantics; their per-agent scoping is dispatch-level in the bridge (T4). Built-in RO enforcement is unchanged (B.2 plugin guard).

## Not probed here
- The bridge plugin's `/tools` session-scoping question (plan T0 Q4) is about OUR bridge, answered in code: `bridge/server.ts` header documents `/tools` is fetched once at plugin load (NOT session-scoped), so bridged-tool per-agent scoping MUST be dispatch-level (T4 registers handlers per role in `buildSessionHandlers`). No live probe needed.
