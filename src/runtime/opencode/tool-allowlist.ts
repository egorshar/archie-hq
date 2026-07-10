/**
 * Per-turn external-MCP tool DENYLIST for opencode (body.tools). config.mcp is
 * server-global, so every session sees every MCP server's tools. The B.3 T0
 * spike (b3-spike.md) pinned that body.tools is a denylist overlay — unlisted
 * tools stay ON — so to restrict a turn to the external servers THIS agent
 * declared (def.mcpServers), we DISABLE every other external server via the
 * `<server>_*` wildcard. body.tools globs are raw string-PREFIX matches and MCP
 * tools are named `<server>_<tool>` (T0 spike), so the deny key must carry the
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
  return deny;
}
