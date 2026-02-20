/**
 * Agent State Management
 *
 * Single source of truth for all agent state transitions.
 * Updates both in-memory runtime state and persisted metadata.
 *
 * Shutdown guard: deactivation writes are silently skipped during shutdown
 * so recovery on restart sees the correct pre-shutdown state.
 *
 * Stage 3: Idle detection — when an agent goes inactive, checks if ALL
 * spawned agents are inactive and triggers progressive recovery.
 */

import { loadMetadata, saveMetadata } from './task-manager.js';
import type { TaskRuntimeState } from './active-tasks.js';
import type { AgentName, AgentSessionState, TaskMetadata } from '../types/index.js';
import { getIsShuttingDown } from './server.js';
import { logger } from './logger.js';
import { AGENT_PROMPTS } from '../agents/prompts.js';

/**
 * Debounced persistence — coalesces rapid state changes into a single disk write.
 * Instead of per-agent load-modify-save (which races), we snapshot ALL sessions
 * from the in-memory runtime after a short delay.
 */
const DEBOUNCE_MS = 500;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const debouncedRuntimes = new Map<string, TaskRuntimeState>();

function schedulePersist(runtime: TaskRuntimeState): void {
  const taskId = runtime.taskId;
  debouncedRuntimes.set(taskId, runtime);

  const existing = debounceTimers.get(taskId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(taskId, setTimeout(() => {
    debounceTimers.delete(taskId);
    debouncedRuntimes.delete(taskId);
    flushSessionsToDisk(runtime).catch((err) =>
      logger.error('agent-state', `Failed to persist sessions for task ${taskId}`, err)
    );
  }, DEBOUNCE_MS));
}

async function flushSessionsToDisk(runtime: TaskRuntimeState): Promise<void> {
  const metadata = await loadMetadata(runtime.taskId);
  if (!metadata) return;

  // Snapshot all in-memory sessions into metadata
  for (const [name, session] of runtime.sessions) {
    metadata.agent_sessions[name] = { ...session };
  }

  await saveMetadata(runtime.taskId, metadata);
}

/**
 * Cancel a pending debounce timer without flushing.
 * Used by nuclear recovery to discard stale writes before clearing sessions.
 */
function cancelPendingPersist(taskId: string): void {
  const timer = debounceTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(taskId);
    debouncedRuntimes.delete(taskId);
  }
}

/**
 * Force an immediate flush — used by stopTask/completeTask before removing from memory.
 */
export async function flushPendingPersist(taskId: string): Promise<void> {
  const timer = debounceTimers.get(taskId);
  const runtime = debouncedRuntimes.get(taskId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(taskId);
    debouncedRuntimes.delete(taskId);
  }
  if (runtime) {
    await flushSessionsToDisk(runtime);
  }
}

/**
 * Read helper for legacy agent_sessions entries.
 * If the entry is a legacy string (old metadata on disk), convert it
 * to an AgentSessionState. Returns undefined if no entry exists.
 */
export function getAgentSession(
  metadata: TaskMetadata,
  agentName: string
): AgentSessionState | undefined {
  const entry = metadata.agent_sessions[agentName];
  if (!entry) return undefined;
  if (typeof entry === 'string') {
    return { session_id: entry, active: false };
  }
  return entry;
}

/**
 * Update an agent's active state — single source of truth for all state transitions.
 * Updates both in-memory runtime state and persisted metadata.
 *
 * During shutdown, deactivation writes are silently skipped so recovery
 * sees the correct pre-shutdown state.
 *
 * Persistence is fire-and-forget to avoid blocking agent processing.
 */
export function updateAgentState(
  runtime: TaskRuntimeState,
  agentName: AgentName | string,
  active: boolean,
  sessionId?: string
): void {
  // During shutdown, skip deactivation — preserve state for recovery
  if (!active && getIsShuttingDown()) return;

  const name = agentName as AgentName;

  // 1. Update in-memory runtime
  const session = runtime.sessions.get(name);
  if (session) {
    if (sessionId) session.session_id = sessionId;
    session.active = active;
    session.last_activity = new Date().toISOString();
  } else if (sessionId) {
    // Initial store — create the entry
    runtime.sessions.set(name, {
      session_id: sessionId,
      active,
      last_activity: new Date().toISOString(),
    });
  }

  // 2. Persist to metadata (debounced — coalesces rapid changes into one write)
  schedulePersist(runtime);

  // 3. Stage 3: after deactivation, check if all agents are inactive
  if (!active) {
    scheduleIdleCheck(runtime);
  }
}


// ============================================================================
// Stage 3: Idle Detection & Progressive Recovery
// ============================================================================

/**
 * Schedule an idle check after an agent goes inactive.
 * Small delay to avoid racing with message delivery
 * (another agent may be about to send a message that wakes this one).
 */
function scheduleIdleCheck(runtime: TaskRuntimeState): void {
  setTimeout(async () => {
    if (!runtime.isActive || getIsShuttingDown()) return;

    const allInactive = checkAllAgentsInactive(runtime);
    if (allInactive) {
      await triggerRecovery(runtime);
    }
  }, 3000);
}

/**
 * Check if all spawned agents are inactive.
 */
function checkAllAgentsInactive(runtime: TaskRuntimeState): boolean {
  if (runtime.spawned.size === 0) return false;

  for (const agentName of runtime.spawned) {
    const session = runtime.sessions.get(agentName);
    if (session?.active) return false;
  }
  return true;
}

/**
 * Progressive recovery when all agents go idle:
 * - Attempts 1-2: Reinforcement — nudge the lead agent with a prompt
 * - Attempt 3+: Nuclear — clear all sessions and restart with fresh context
 *
 * Works entirely in-memory. No direct metadata reads/writes — the debounced
 * persist will snapshot whatever runtime.sessions looks like when it fires.
 */
async function triggerRecovery(runtime: TaskRuntimeState): Promise<void> {
  runtime.recoveryAttempts += 1;

  logger.warn('recovery', `All agents inactive for task ${runtime.taskId} (attempt ${runtime.recoveryAttempts})`);

  if (runtime.recoveryAttempts >= 3) {
    // Nuclear: clear all sessions in-memory so the flush writes empty state
    runtime.sessions.clear();
    runtime.recoveryAttempts = 0;

    // Cancel any pending debounce — we'll flush the cleared state in stopTask
    cancelPendingPersist(runtime.taskId);

    // Lazy import to avoid circular dependency
    const { stopTask } = await import('./task-runtime.js');
    const { reactivateTask } = await import('./event-handler.js');

    await stopTask(runtime.taskId);
    await reactivateTask(runtime.taskId, 'recovery');
  } else {
    // Reinforcement: nudge the lead agent
    const target = runtime.metadata.task_owner || 'pm-agent';
    const handle = runtime.handles.get(target as AgentName);
    const queue = runtime.queues.get(target as AgentName);

    // Only nudge if the agent process is actually running (not crashed)
    if (queue && handle?.isRunning) {
      const prompt = target === 'pm-agent'
        ? AGENT_PROMPTS.reinforcePM
        : AGENT_PROMPTS.reinforceAgent;
      queue.addMessage(prompt);

      updateAgentState(runtime, target, true);
    } else {
      // Agent process is dead — skip straight to nuclear on next idle check
      runtime.recoveryAttempts = 2;
    }
  }
}
