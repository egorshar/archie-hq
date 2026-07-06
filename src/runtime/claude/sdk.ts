/**
 * The ONE place `@anthropic-ai/claude-agent-sdk` is imported (spec P4/R4:
 * confine vendor imports to the runtime module). Every other file imports SDK
 * symbols from here so the isolation grep stays green and a future SDK swap or
 * version pin touches a single file.
 */

export { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
export type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
