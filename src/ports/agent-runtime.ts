/**
 * AgentRuntime — the agent-runtime seam (spec §3.3). ClaudeSdkRuntime today;
 * OpencodeRuntime in Phase 2. Phase-0 shape mirrors the existing spawnAgent
 * contract: spawn() mutates `agent` (sets agent.handle) and resolves when setup
 * is done. The AgentSpawnSpec/RuntimeEvent normalization arrives in Phase 2.
 */

import type { RuntimeCapabilities } from './capabilities.js';
import type { Agent } from '../agents/agent.js';
import type { Task } from '../tasks/task.js';
import type { AgentDef } from '../types/agent.js';

export interface AgentRuntime {
  readonly kind: 'claude' | 'opencode';
  capabilities(): RuntimeCapabilities;
  /**
   * Pre-beautify footer label token for a single agent — the message footer
   * runs each token through `modelDisplayLabel`. Claude returns the resolved
   * alias (`opus` / `sonnet[1m]`); opencode returns the agent's route trimmed to
   * a beautify-ready id, or null when unresolved. Keeps the footer's runtime
   * branch out of the Task class (the model label is the runtime's concern, so
   * `task.ts` never imports a runtime module). Best-effort — must not throw.
   */
  footerModelToken(def: AgentDef): string | null;
  /**
   * Fallback footer token when no agent resolved one (e.g. before any agent
   * spawns). Claude → `'opus'`; opencode → the server-default route, or null.
   * Best-effort — must not throw.
   */
  footerModelDefaultToken(): string | null;
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
  /**
   * Called when a task is torn down (stop/complete), after its agents' queues
   * are stopped. Lets a runtime release per-task process state — the opencode
   * runtime closes the task's per-agent serve children and removes their
   * synthetic serve roots (P3a evictTask); the Claude runtime holds no
   * per-task process state, so it omits this. Optional and invoked as
   * `getAgentRuntime().onTaskTeardown?.(taskId)` (same precedent as
   * `shutdown?()`); implementations must be best-effort and never throw.
   */
  onTaskTeardown?(taskId: string): Promise<void>;
}
