/**
 * Task.stop()/complete() must invoke the runtime's optional onTaskTeardown hook
 * (P3a: the opencode pool closes the task's serve children + rm's synthetic
 * serve roots there). Claude runtime omits the hook — optional chaining makes
 * that a no-op, and a hook failure must never break teardown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
}));
const { runtimeMock } = vi.hoisted(() => ({
  runtimeMock: {
    kind: 'opencode',
    onTaskTeardown: vi.fn(async () => {}),
    footerModelToken: () => null,
    footerModelDefaultToken: () => null,
  } as any,
}));
vi.mock('../../system/backends.js', () => ({ getAgentRuntime: () => runtimeMock }));

import { Task, activeTasks } from '../task.js';
import type { TaskMetadata } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (taskId: string, metadata: TaskMetadata, team: AgentDef[]) => Task;
const TASK_ID = 'task-20260711-0000-p3a-teardown';

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID, task_owner: 'pm-agent', participants: [], channels: {},
    default_channel: null, agent_sessions: {}, repositories: {}, status: 'in_progress',
    created_at: '2026-07-11T00:00:00.000Z', updated_at: '2026-07-11T00:00:00.000Z',
  } as TaskMetadata;
}

describe('Task teardown → AgentRuntime.onTaskTeardown', () => {
  beforeEach(() => {
    runtimeMock.onTaskTeardown.mockClear();
    activeTasks.delete(TASK_ID);
  });

  it('stop() invokes onTaskTeardown with the taskId', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    (task as any).isActive = true;
    await task.stop();
    expect(runtimeMock.onTaskTeardown).toHaveBeenCalledWith(TASK_ID);
  });

  it('complete() invokes onTaskTeardown with the taskId', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), []);
    (task as any).isActive = true;
    await task.complete();
    expect(runtimeMock.onTaskTeardown).toHaveBeenCalledWith(TASK_ID);
  });

  it('teardown survives a hook failure and a runtime without the hook (claude parity)', async () => {
    runtimeMock.onTaskTeardown.mockRejectedValueOnce(new Error('rm failed'));
    const t1 = new TaskCtor(TASK_ID, metadata(), []);
    (t1 as any).isActive = true;
    await expect(t1.stop()).resolves.toBeUndefined();

    activeTasks.delete(TASK_ID);
    const saved = runtimeMock.onTaskTeardown;
    delete runtimeMock.onTaskTeardown;
    const t2 = new TaskCtor(TASK_ID, metadata(), []);
    (t2 as any).isActive = true;
    await expect(t2.stop()).resolves.toBeUndefined();
    runtimeMock.onTaskTeardown = saved;
  });
});
