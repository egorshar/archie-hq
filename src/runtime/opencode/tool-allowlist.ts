/**
 * Per-turn external-MCP tool DENYLIST for opencode (body.tools). config.mcp is
 * server-global, so every session sees every MCP server's tools. The B.3 T0
 * spike (b3-spike.md) pinned that body.tools is a denylist overlay — unlisted
 * tools stay ON — so to restrict a turn to the external servers THIS agent
 * declared (def.mcpServers), we DISABLE every other external server via the
 * confirmed `<server>*` wildcard. The agent's own servers, all built-ins, and
 * the bridge's custom tools are left untouched (unlisted → on). Parity with the
 * Claude path, where an agent's query() only mounts its own servers.
 */
import type { Agent } from '../../agents/agent.js';
import { getRootMcpConfig } from '../../system/plugin-loader.js';

export function buildToolAllowlist(agent: Agent): Record<string, boolean> {
  const declared = new Set(Object.keys((agent.def as any).mcpServers ?? {}));
  const all = Object.keys(getRootMcpConfig().servers ?? {});
  const deny: Record<string, boolean> = {};
  for (const name of all) {
    if (!declared.has(name)) deny[`${name}*`] = false;
  }
  return deny;
}
