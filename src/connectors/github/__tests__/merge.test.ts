/**
 * Unit tests for the merge orchestrator's policy gating and ready notification.
 *
 * Drives checkAndMergeLinkedPRs against a minimal fake task (no LLM, mocked
 * GitHubClient + registry) to prove: non-auto ready PRs are held and notified
 * exactly once per continuous ready period (AC1), auto repos merge as today
 * (AC2), mixed-policy tasks are evaluated per PR, the marker clears on
 * un-ready and survives reload, and a pending merge approval suppresses the
 * ready nudge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  createGitHubClient: vi.fn(),
}));

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn() },
}));

vi.mock('../../../tasks/persistence.js', () => ({
  appendAgentFinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../agents/registry.js', () => ({
  isAutoMergeRepo: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), plain: vi.fn(),
  },
}));

import { checkAndMergeLinkedPRs } from '../merge.js';
import { createGitHubClient } from '../client.js';
import { Task } from '../../../tasks/task.js';
import { appendAgentFinding } from '../../../tasks/persistence.js';
import { isAutoMergeRepo } from '../../../agents/registry.js';
import { AGENT_PROMPTS } from '../../../agents/prompts.js';
import type { TaskMetadata, BranchState } from '../../../types/task.js';

const mockGitHubClient = {
  getPRStatus: vi.fn(),
  mergePullRequest: vi.fn(),
};

const READY = { state: 'open', mergeable: true, mergeableState: 'clean', approved: true };
const NOT_READY = { state: 'open', mergeable: false, mergeableState: 'blocked', approved: true };

type FakeTask = {
  taskId: string;
  metadata: Pick<TaskMetadata, 'repositories' | 'pending_merge_approval'>;
  debouncedSave: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

function makeTask(
  repositories: TaskMetadata['repositories'],
  pendingMergeApproval?: TaskMetadata['pending_merge_approval'],
): FakeTask {
  return {
    taskId: 'task-123',
    metadata: { repositories, pending_merge_approval: pendingMergeApproval },
    debouncedSave: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function singlePRRepositories(github: string, prNumber: number): TaskMetadata['repositories'] {
  return {
    'backend-agent': [
      { github, branch_states: { 'feat/x': { pr_number: prNumber, base_branch: 'main' } } },
    ],
  };
}

function branchState(task: FakeTask, agentId: string, branch: string): BranchState {
  return task.metadata.repositories[agentId]![0]!.branch_states![branch]!;
}

/** Findings that are the ready notification (decision finding naming the held PR). */
function readyNotifications(): unknown[][] {
  return vi.mocked(appendAgentFinding).mock.calls.filter(
    (call) => call[3] === 'decision' && String(call[2]).includes('do not auto-merge'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createGitHubClient).mockReturnValue(mockGitHubClient as never);
  vi.mocked(isAutoMergeRepo).mockReturnValue(false);
});

describe('checkAndMergeLinkedPRs — non-auto policy (AC1)', () => {
  it('holds a ready non-auto PR and notifies exactly once across a webhook burst', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);

    await checkAndMergeLinkedPRs('task-123');
    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    const notifications = readyNotifications();
    expect(notifications).toHaveLength(1);
    expect(String(notifications[0]![2])).toContain('org/backend#42');
    expect(task.sendMessage).toHaveBeenCalledTimes(1);
    expect(task.sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBe(true);
  });

  it('suppresses the ready nudge for a PR whose merge approval is pending', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42), {
      github: 'org/backend', pr_number: 42,
      requested_by: 'backend-agent', requested_at: '2026-07-06T00:00:00.000Z',
    });
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);

    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).not.toHaveBeenCalled();
    expect(readyNotifications()).toHaveLength(0);
    expect(task.sendMessage).not.toHaveBeenCalled();
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBeUndefined();
  });

  it('notifies again after the PR goes un-ready and becomes ready once more (marker cleared)', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);

    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(1);

    mockGitHubClient.getPRStatus.mockResolvedValue(NOT_READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(1);
    expect(branchState(task, 'backend-agent', 'feat/x').merge_ready_notified).toBeUndefined();

    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(2);
  });

  it('does not re-notify after a task reload — the marker is persisted metadata', async () => {
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);

    await checkAndMergeLinkedPRs('task-123');
    expect(readyNotifications()).toHaveLength(1);
    expect(task.debouncedSave).toHaveBeenCalled();

    // Simulate restart: a fresh Task instance built from the persisted metadata JSON.
    const reloaded = makeTask(
      JSON.parse(JSON.stringify(task.metadata.repositories)) as TaskMetadata['repositories'],
    );
    vi.mocked(Task.get).mockResolvedValue(reloaded as unknown as Task);

    await checkAndMergeLinkedPRs('task-123');

    expect(readyNotifications()).toHaveLength(1);
    expect(reloaded.sendMessage).not.toHaveBeenCalled();
  });
});

describe('checkAndMergeLinkedPRs — auto policy (AC2)', () => {
  it('merges a ready PR in an auto repo as today, with no ready notification', async () => {
    vi.mocked(isAutoMergeRepo).mockReturnValue(true);
    const task = makeTask(singlePRRepositories('org/backend', 42));
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });

    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/backend', 42);
    expect(readyNotifications()).toHaveLength(0);
    expect(appendAgentFinding).toHaveBeenCalledWith(
      'task-123', 'system', expect.stringContaining('org/backend#42'), 'completion',
    );
  });
});

describe('checkAndMergeLinkedPRs — mixed-policy task', () => {
  it('merges the auto PR while the non-auto PR is held with a ready notification', async () => {
    vi.mocked(isAutoMergeRepo).mockImplementation((github: string) => github === 'org/auto');
    const task = makeTask({
      'backend-agent': [
        { github: 'org/auto', branch_states: { 'feat/a': { pr_number: 1, base_branch: 'main' } } },
      ],
      'mobile-agent': [
        { github: 'org/manual', branch_states: { 'feat/b': { pr_number: 2, base_branch: 'main' } } },
      ],
    });
    vi.mocked(Task.get).mockResolvedValue(task as unknown as Task);
    mockGitHubClient.getPRStatus.mockResolvedValue(READY);
    mockGitHubClient.mergePullRequest.mockResolvedValue({ success: true, message: 'merged' });

    await checkAndMergeLinkedPRs('task-123');

    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockGitHubClient.mergePullRequest).toHaveBeenCalledWith('org/auto', 1);
    const notifications = readyNotifications();
    expect(notifications).toHaveLength(1);
    expect(String(notifications[0]![2])).toContain('org/manual#2');
    expect(String(notifications[0]![2])).not.toContain('org/auto#1');
    expect(branchState(task, 'mobile-agent', 'feat/b').merge_ready_notified).toBe(true);
    expect(branchState(task, 'backend-agent', 'feat/a').merge_ready_notified).toBeUndefined();
  });
});
