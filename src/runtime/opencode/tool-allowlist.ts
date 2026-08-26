/**
 * Per-turn external-MCP tool DENYLIST for opencode (body.tools). config.mcp is
 * server-global, so every session sees every MCP server's tools. opencode's
 * body.tools is a denylist overlay — unlisted tools stay ON — so to restrict a
 * turn to the external servers THIS agent
 * declared (def.mcpServers), we DISABLE every other external server via the
 * `<server>_*` wildcard. body.tools globs are raw string-PREFIX matches and MCP
 * tools are named `<server>_<tool>`, so the deny key must carry the
 * `_` separator: `jira_*` scopes exactly to `jira`'s tools and does NOT collide
 * with a declared `jira-cloud` (whose tools start with `jira-`, not `jira_`). A
 * bare `jira*` would silently disable `jira-cloud` too. The agent's own
 * servers, all built-ins, and the bridge's custom tools are left untouched
 * (unlisted → on). Parity with the Claude path, where an agent's query() only
 * mounts its own servers.
 */
import type { Agent } from '../../agents/agent.js';
import { getRootMcpConfig } from '../../system/plugin-loader.js';

export function buildToolAllowlist(agent: Agent): Record<string, boolean> {
  const declared = new Set(Object.keys(agent.def.mcpServers ?? {}));
  const all = Object.keys(getRootMcpConfig().servers ?? {});
  const deny: Record<string, boolean> = {};
  for (const name of all) {
    if (!declared.has(name)) deny[`${name}_*`] = false;
  }

  // Withhold `deny`-tiered tools of the agent's OWN servers, the way the Claude
  // path passes `deniedToolNames()` to the SDK's `disallowedTools`. Withholding
  // beats refusing at call time: the model never sees the tool, so it does not
  // spend a turn discovering it cannot use it.
  //
  // Only tools listed explicitly — a `deny` DEFAULT is deliberately not expanded
  // here, matching `deniedToolNames`: the server's full tool list is not known up
  // front, and the call-time gate is what covers a tool the server adds later.
  //
  // Keys are opencode's `<server>_<tool>` form, not the policy's `mcp__…` names.
  for (const [server, serverPolicy] of Object.entries(agent.def.mcpPolicy ?? {})) {
    for (const [tool, tier] of Object.entries(serverPolicy.tiers)) {
      if (tier === 'deny') deny[`${server}_${tool}`] = false;
    }
  }

  return deny;
}
