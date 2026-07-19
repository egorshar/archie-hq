/**
 * ClaudeSdkRuntime — the AgentRuntime backed by the Claude Agent SDK. Phase 0
 * delegates straight to the existing spawnAgent(); the SDK event-loop, hooks,
 * sandbox, and session recovery all stay in spawn.ts. Phase 2 adds OpencodeRuntime
 * alongside this and normalizes the AgentSpawnSpec/RuntimeEvent model.
 */

import type { AgentRuntime } from '../../ports/agent-runtime.js';
import type { RuntimeCapabilities } from '../../ports/capabilities.js';
import { CLAUDE_RUNTIME_CAPABILITIES } from '../../ports/capabilities.js';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import type { AgentDef } from '../../types/agent.js';
import { spawnAgent } from '../../agents/spawn.js';
import { resolveAgentModel } from '../../agents/model-label.js';

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly kind = 'claude' as const;

  capabilities(): RuntimeCapabilities {
    return CLAUDE_RUNTIME_CAPABILITIES;
  }

  /** The resolved alias (`opus` / `sonnet[1m]` / `def.model`) — never null.
   * Honours the task's max-mode upgrade so the footer reflects any model swap. */
  footerModelToken(def: AgentDef, maxMode: boolean): string | null {
    return resolveAgentModel(def, maxMode);
  }

  /** Mirrors spawn's PM default when no agent has resolved a token yet. */
  footerModelDefaultToken(): string | null {
    return 'opus';
  }

  async spawn(agent: Agent, task: Task): Promise<void> {
    await spawnAgent(agent, task);
  }
}

export const claudeSdkRuntime = new ClaudeSdkRuntime();
