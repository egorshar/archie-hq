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
  /**
   * Release any process-global resources the runtime holds (e.g. an embedded
   * server child + bridge). Called once from the process shutdown path
   * (SIGINT/SIGTERM). Optional: a runtime with nothing to release (the Claude
   * SDK) omits it, so callers invoke it as `getAgentRuntime().shutdown?.()`.
   */
  shutdown?(): Promise<void>;
}
