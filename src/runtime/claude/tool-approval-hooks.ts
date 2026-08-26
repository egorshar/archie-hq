/**
 * Claude adapter for the MCP tool-approval gate.
 *
 * The decision itself — tiers, grants, the deny-then-retry shape, the fail-closed
 * rule — lives in `agents/tool-approval-gate.ts` and is shared with the opencode
 * runtime. All this file does is speak the SDK's hook dialect: pull the tool name
 * and arguments out of the PreToolUse input, and turn a {@link GateDecision} into
 * the `hookSpecificOutput` shape the SDK reads.
 *
 * Kept in the runtime rather than in `agents/` so the hook types are imported
 * through `./sdk.js` — the seam that keeps `@anthropic-ai/claude-agent-sdk` out of
 * every other module.
 */

import { decideToolCall, type GateDecision, type McpToolPolicy, type ToolApprovalPort } from '../../agents/tool-approval-gate.js';
import type { HookCallbackMatcher, HookJSONOutput } from './sdk.js';

function toHookOutput(decision: GateDecision): HookJSONOutput {
  if (decision.allow) return { continue: true };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: decision.reason,
    },
  };
}

/**
 * PreToolUse hooks enforcing the tool policy of this agent's MCP servers.
 *
 * Returns a single matcher (no `matcher` field → fires on all tools) that filters
 * by tool name inside the callback, mirroring `createFilesystemGuardHooks`.
 * Unmanaged tools always proceed, even when the gate's own dependencies are broken.
 */
export function createToolApprovalHooks(policy: McpToolPolicy, port: ToolApprovalPort): HookCallbackMatcher[] {
  return [{
    // Generous explicit budget: the deny path posts to Slack and fsyncs metadata
    // inside the hook, and what a host does with a TIMED-OUT PreToolUse decision
    // is its policy, not ours — so never get near the default.
    timeout: 120,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hooks: [async (input: any): Promise<HookJSONOutput> => {
      const toolName = typeof input?.tool_name === 'string' ? input.tool_name : undefined;
      return toHookOutput(await decideToolCall(policy, port, toolName, input?.tool_input));
    }],
  }];
}
