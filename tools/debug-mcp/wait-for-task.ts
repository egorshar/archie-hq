/**
 * wait_for_task core — bounded, resumable waiting for an Archie task to reach a
 * terminal/actionable state.
 *
 * Pure logic over a minimal client surface (TaskClient) so it is unit-testable
 * with a fake client — no running server and no MCP transport. The real
 * ArchieClient satisfies TaskClient structurally.
 */

export type WaitState =
  | 'completed'
  | 'stopped'
  | 'approval_requested'
  | 'pending'
  | 'not_found';

export type ApprovalType = 'edit_mode' | 'research_budget';

export interface WaitResult {
  task_id: string | null;
  state: WaitState;
  attribution: string | null;
  pm_replies: string[];
  cursor?: number;
  approval_type?: ApprovalType;
}

export interface WaitForTaskArgs {
  taskId?: string;
  nonce?: string;
  timeoutSeconds?: number;
  cursor?: number;
}

/** The slice of ArchieClient the wait logic needs (the real client satisfies it structurally). */
export interface TaskClient {
  listTasks(): Promise<Array<{ task_id: string }>>;
  getTaskDetail(taskId: string): Promise<{ knowledgeLog: string }>;
  getEvents(
    taskId: string,
    after?: number,
  ): Promise<{ events: Array<{ type: string; data: Record<string, unknown> }>; total: number }>;
}

export interface WaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on a single call's wait, kept below the MCP client tool-call timeout. */
  capSeconds?: number;
  pollIntervalMs?: number;
  /** How many most-recent tasks to scan when correlating by nonce. */
  recentWindow?: number;
}

const DEFAULT_CAP_SECONDS = 45;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_RECENT_WINDOW = 25;
const ATTRIBUTION_MAX = 512;

function firstNonEmptyLine(log: string): string | null {
  const line = (log || '').split('\n').find((s) => s.trim().length > 0);
  return line ? line.slice(0, ATTRIBUTION_MAX) : null;
}

async function findTaskByNonce(
  client: TaskClient,
  nonce: string,
  recentWindow: number,
): Promise<string | undefined> {
  const tasks = await client.listTasks();
  for (const t of tasks.slice(0, recentWindow)) {
    try {
      const detail = await client.getTaskDetail(t.task_id);
      if (detail.knowledgeLog && detail.knowledgeLog.includes(nonce)) {
        return t.task_id;
      }
    } catch {
      // task vanished or unreadable mid-scan — skip it
    }
  }
  return undefined;
}

/**
 * Resolve a task (by id or nonce) and block until it reaches a terminal/actionable
 * state — `completed`, `stopped`, or `approval_requested` — or the wait cap is hit
 * (`pending`, with a cursor to resume). Returns `not_found` if a nonce never
 * correlates within the budget.
 */
export async function waitForTask(
  client: TaskClient,
  args: WaitForTaskArgs,
  deps: WaitDeps = {},
): Promise<WaitResult> {
  if (!args.taskId && !args.nonce) {
    throw new Error('wait_for_task requires either "task_id" or "nonce"');
  }

  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const capSeconds = deps.capSeconds ?? DEFAULT_CAP_SECONDS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const recentWindow = deps.recentWindow ?? DEFAULT_RECENT_WINDOW;

  const budgetSeconds = Math.min(args.timeoutSeconds ?? capSeconds, capSeconds);
  const deadline = now() + budgetSeconds * 1000;

  let taskId = args.taskId;
  let cursor = args.cursor;
  let attribution: string | null = null;
  let attributionTried = false;
  const pmReplies: string[] = [];

  for (;;) {
    if (!taskId && args.nonce) {
      taskId = await findTaskByNonce(client, args.nonce, recentWindow);
    }

    if (taskId) {
      if (!attributionTried) {
        attributionTried = true;
        try {
          const detail = await client.getTaskDetail(taskId);
          attribution = firstNonEmptyLine(detail.knowledgeLog);
        } catch {
          // attribution is best-effort
        }
      }

      const res = await client.getEvents(taskId, cursor);
      cursor = res.total;

      let completed = false;
      let stopped = false;
      let approval = false;
      let approvalType: ApprovalType | undefined;

      for (const e of res.events) {
        if (e.type === 'task:completed') completed = true;
        else if (e.type === 'task:stopped') stopped = true;
        else if (e.type === 'approval:requested') {
          approval = true;
          const ty = e.data['type'];
          if (ty === 'edit_mode' || ty === 'research_budget') approvalType = ty;
        }
        if (e.type === 'message' && e.data['from'] === 'pm-agent') {
          pmReplies.push(String(e.data['message'] ?? ''));
        }
      }

      // Terminal states win over a replayed approval gate (the feed replays full history).
      if (completed) return { task_id: taskId, state: 'completed', attribution, pm_replies: pmReplies, cursor };
      if (stopped) return { task_id: taskId, state: 'stopped', attribution, pm_replies: pmReplies, cursor };
      if (approval) {
        return {
          task_id: taskId,
          state: 'approval_requested',
          attribution,
          pm_replies: pmReplies,
          cursor,
          ...(approvalType ? { approval_type: approvalType } : {}),
        };
      }
    }

    if (now() >= deadline) {
      if (!taskId) {
        return { task_id: null, state: 'not_found', attribution: null, pm_replies: [] };
      }
      return { task_id: taskId, state: 'pending', attribution, pm_replies: pmReplies, cursor };
    }

    await sleep(pollIntervalMs);
  }
}
