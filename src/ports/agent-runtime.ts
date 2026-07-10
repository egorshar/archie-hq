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
  /**
   * Called after the plugins repo hot-reloads AND the agent registry has been
   * rebuilt (so `getAllAgentDefs()` already reflects the new plugins). Lets a
   * runtime refresh any process-global state it derived from the agent set at
   * boot. Optional and invoked as `getAgentRuntime().onPluginsRefreshed?.()`
   * (same precedent as `shutdown?()`): the Claude runtime re-links skills per
   * spawn, so it omits this; the opencode runtime re-stages the shared embedded
   * server's `.opencode/skills` dir, which is otherwise staged only once at boot
   * and would keep serving stale skill contents after a plugins push. Routing
   * this through the port keeps the plugins-refresh path runtime-agnostic — it
   * imports zero `runtime/opencode` modules, so the claude path never touches
   * opencode code on refresh. Best-effort: implementations must not throw
   * (a failure must never break the plugins refresh).
   */
  onPluginsRefreshed?(): Promise<void>;
}
