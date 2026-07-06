/**
 * AgentRuntime — the agent-runtime seam (spec §3.3). ClaudeSdkRuntime today;
 * OpencodeRuntime in Phase 2. Phase-0 shape mirrors the existing spawnAgent
 * contract: spawn() mutates `agent` (sets agent.handle) and resolves when setup
 * is done. The AgentSpawnSpec/RuntimeEvent normalization arrives in Phase 2.
 */

import type { RuntimeCapabilities } from './capabilities.js';
import type { Agent } from '../agents/agent.js';
import type { Task } from '../tasks/task.js';

export interface AgentRuntime {
  readonly kind: 'claude' | 'opencode';
  capabilities(): RuntimeCapabilities;
  /**
   * Spawn `agent` for `task`. Mutates `agent` (sets agent.sandbox, agent.handle).
   * Idempotency and crash-detection wiring remain in Agent.spawn(); this is the
   * runtime-specific process launch.
   */
  spawn(agent: Agent, task: Task): Promise<void>;
}
