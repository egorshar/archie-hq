/**
 * Backend resolver (agent-runtime seam). Resolves AGENT_RUNTIME env into a
 * concrete AgentRuntime + LlmOneShot factory. Ships two runtimes — the Claude
 * Agent SDK (default) and opencode — behind a single resolver so call sites
 * never branch on the runtime. Fails fast with actionable messages at boot.
 */

import type { AgentRuntime } from '../ports/agent-runtime.js';
import type { LlmOneShot } from '../ports/llm-one-shot.js';
import { claudeSdkRuntime } from '../runtime/claude/runtime.js';
import { claudeLlmOneShot } from '../runtime/claude/llm-one-shot.js';
import { opencodeLlmOneShot } from '../runtime/opencode/llm-one-shot.js';
import { opencodeRuntime } from '../runtime/opencode/runtime.js';
import { logger } from './logger.js';

export type AgentRuntimeKind = 'claude' | 'opencode';

const SUPPORTED_RUNTIMES: AgentRuntimeKind[] = ['claude', 'opencode'];

export function resolveAgentRuntimeKind(): AgentRuntimeKind {
  const raw = (process.env.AGENT_RUNTIME ?? 'claude').trim().toLowerCase();
  return raw as AgentRuntimeKind;
}

export function getBackendMatrix(): { runtime: string } {
  return { runtime: resolveAgentRuntimeKind() };
}

/**
 * The runtime routes logical model names via ARCHIE_OPENCODE_MODEL_<TIER> /
 * _DEFAULT (see runtime/opencode/model.ts). Require at least one so model
 * resolution can't fail at spawn with no route configured.
 */
function assertOpencodeEnv(): void {
  const hasRoute = Object.keys(process.env).some((k) => k.startsWith('ARCHIE_OPENCODE_MODEL_'));
  if (!hasRoute) {
    throw new Error(
      'AGENT_RUNTIME=opencode requires a model route: set ARCHIE_OPENCODE_MODEL_DEFAULT ' +
      '(or a per-tier ARCHIE_OPENCODE_MODEL_<TIER>, e.g. ARCHIE_OPENCODE_MODEL_OPUS) to a "provider/model" value.',
    );
  }
}

/**
 * Validate the selected runtime is supported in this build. Throw with an
 * actionable message otherwise. Call once at boot (see index.ts).
 */
export function assertBackendConfig(): void {
  const runtime = resolveAgentRuntimeKind();
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    throw new Error(`AGENT_RUNTIME="${runtime}" is invalid. Supported values: ${SUPPORTED_RUNTIMES.join(', ')}.`);
  }
  if (runtime === 'opencode') assertOpencodeEnv();
}

/**
 * The active AgentRuntime — 'claude' (default) or 'opencode'. The default
 * branch guards against a mis-sequenced call (assertBackendConfig() rejects
 * unsupported values at boot).
 */
export function getAgentRuntime(): AgentRuntime {
  const runtime = resolveAgentRuntimeKind();
  switch (runtime) {
    case 'claude':
      return claudeSdkRuntime;
    case 'opencode':
      return opencodeRuntime;
    default:
      logger.warn('backends', `getAgentRuntime() called for unsupported runtime "${runtime}"; defaulting to claude`);
      return claudeSdkRuntime;
  }
}

/**
 * The active LlmOneShot (one-shot prompt→text/JSON calls). Tied to the agent
 * runtime selection: opencode when AGENT_RUNTIME=opencode, otherwise the Claude
 * SDK impl (default).
 */
export function getLlmOneShot(): LlmOneShot {
  return resolveAgentRuntimeKind() === 'opencode' ? opencodeLlmOneShot : claudeLlmOneShot;
}
