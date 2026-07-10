/**
 * Translate Archie's plugin-domain MCP servers (the root .mcp.json, Claude-SDK
 * shape) into opencode's native `config.mcp` (spec §3.3 item 1). External MCP
 * servers are already out-of-process, so opencode owns the connection — unlike
 * Archie's in-process tools, which must be bridged. OAuth is reused from
 * Archie's existing binding path (tokens stay in the orchestrator; opencode
 * gets ready Authorization headers), NOT opencode's native oauth auto-detection.
 *
 * config.mcp is server-global (one embedded server shared by all sessions), so
 * this registers the UNION of all servers; per-agent scoping is a turn-level
 * body.tools overlay (see runtime.ts / the B.3 design §4.3).
 */
import { getRootMcpConfig } from '../../system/plugin-loader.js';
import { applyOAuthBindings } from '../../system/oauth/inject.js';
import { logger } from '../../system/logger.js';

type McpRemote = { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean; timeout?: number };
type McpLocal = { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean; timeout?: number };
export type McpEntry = McpRemote | McpLocal;

/** One Claude-SDK-shape server entry → an opencode McpEntry, or null to skip. */
function translate(name: string, cfg: any): McpEntry | null {
  const type = cfg?.type;
  if (type === 'http' || type === 'sse') {
    if (typeof cfg.url !== 'string') { logger.warn('opencode', `MCP "${name}": ${type} entry has no url — skipped`); return null; }
    const entry: McpRemote = { type: 'remote', url: cfg.url };
    if (cfg.headers && typeof cfg.headers === 'object') entry.headers = cfg.headers;
    return entry;
  }
  if (type === 'stdio') {
    if (typeof cfg.command !== 'string') { logger.warn('opencode', `MCP "${name}": stdio entry has no command — skipped`); return null; }
    const entry: McpLocal = { type: 'local', command: [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])] };
    if (cfg.env && typeof cfg.env === 'object') entry.environment = cfg.env;
    return entry;
  }
  logger.warn('opencode', `MCP "${name}": unsupported type "${type}" — skipped`);
  return null;
}

export async function buildOpencodeMcpConfig(): Promise<Record<string, McpEntry>> {
  const { servers } = getRootMcpConfig();
  // Reuse Archie's OAuth binding on a shallow copy (it mutates in place: injects
  // Authorization headers into http/sse entries, deletes entries whose refresh
  // fails). Operating on a copy keeps plugin-loader's cached config clean.
  const bound: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(servers ?? {})) bound[name] = { ...(cfg as object) };
  await applyOAuthBindings(bound);

  const out: Record<string, McpEntry> = {};
  for (const [name, cfg] of Object.entries(bound)) {
    const entry = translate(name, cfg);
    if (entry) out[name] = entry;
  }
  return out;
}
