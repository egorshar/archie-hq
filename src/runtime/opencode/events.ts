/**
 * opencode event consumer (spec §3.3 item 2). One global SSE subscription for
 * the whole embedded server (the server is a process-lifetime singleton). Each
 * event is correlated to a live Archie turn via the bridge sharedRegistry
 * (sessionID → {task, agent}); unknown sessions (one-shot LLM calls, evicted
 * turns) are ignored. Pure observability: it feeds the status line and logs
 * idle/error, and NEVER throws into or stalls a turn. The idle mechanism itself
 * stays prompt()-return (runtime.ts) in P2-C; session.idle is logged only.
 */
import type { OpencodeClient } from './server.js';
import type { SessionRegistry } from './bridge/registry.js';
import { REPO_TOOL_SPECS } from '../../agents/tools.js';
import { logger } from '../../system/logger.js';

export interface EventConsumerHandle {
  stop(): void;
}

/**
 * Repo-tool name set, derived from the same `REPO_TOOL_SPECS` (in
 * `src/agents/tools.ts`) the Claude SDK MCP server and the opencode bridge
 * dispatch both use — single source of truth, no hand-maintained copy that can
 * drift. Computed lazily (not at module top level): this module sits in the
 * existing import cycle (`tools.ts` -> `system/backends.ts` -> opencode's
 * `llm-one-shot.ts` -> `server.ts` -> `events.ts` -> back to `tools.ts`), so
 * `REPO_TOOL_SPECS` is not guaranteed populated at module-eval time. Deferring
 * to first call (and caching) sidesteps the ordering hazard — by the time any
 * event is handled, both modules have fully loaded. Mirrors
 * `bridge/server.ts`'s `getRepoToolDescriptors()`.
 */
let repoToolNames: Set<string> | null = null;
function isRepoTool(tool: string): boolean {
  if (!repoToolNames) repoToolNames = new Set(REPO_TOOL_SPECS.map((s) => s.name));
  return repoToolNames.has(tool);
}

/**
 * Bridged repo-tools surface from opencode as bare names (`push_branch`); the
 * status mapper (activity.ts) keys them under the `mcp__repo-tools__` namespace.
 * Control tools like post_to_user map to null in activity.ts, so they need no
 * prefixing.
 */
function canonicalToolName(tool: string): string {
  return isRepoTool(tool) ? `mcp__repo-tools__${tool}` : tool;
}

/** Correlate one opencode event to a live turn and feed the status line. Never throws. */
export function handleOpencodeEvent(ev: unknown, registry: SessionRegistry): void {
  try {
    const e = ev as { type?: string; properties?: any } | null;
    if (!e || typeof e.type !== 'string') return;

    if (e.type === 'session.idle') {
      const sid = e.properties?.sessionID;
      if (sid && registry.get(sid)) logger.debug('opencode', `session idle: ${sid}`);
      return;
    }
    if (e.type === 'session.error') {
      const sid = e.properties?.sessionID;
      if (sid && registry.get(sid)) logger.warn('opencode', `session error: ${sid}`);
      return;
    }
    if (e.type === 'message.part.updated') {
      const part = e.properties?.part;
      if (!part || part.type !== 'tool' || typeof part.tool !== 'string') return;
      const session = registry.get(part.sessionID);
      if (!session) return; // unknown / one-shot / evicted
      session.task.noteActivity(session.agent.def.id, canonicalToolName(part.tool), part.state?.input ?? {});
      return;
    }
  } catch (err) {
    logger.debug('opencode', `event handler ignored error: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Start the global event consumer. Iterates the SDK's reconnecting SSE stream
 * in the background; the SDK handles retry/backoff internally. Returns a handle
 * whose stop() ends the loop. Startup failure is logged and swallowed (the turn
 * still works without the status line).
 */
export function startEventConsumer(client: OpencodeClient, registry: SessionRegistry): EventConsumerHandle {
  let stopped = false;
  (async () => {
    try {
      const { stream } = await client.event.subscribe();
      for await (const ev of stream as AsyncIterable<unknown>) {
        // stop() is best-effort: the loop unblocks on the next event / stream close.
        if (stopped) break;
        handleOpencodeEvent(ev, registry);
      }
    } catch (err) {
      if (!stopped) logger.warn('opencode', `event stream ended: ${(err as Error)?.message ?? err}`);
    }
  })();
  return { stop() { stopped = true; } };
}
