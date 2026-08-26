/**
 * The GitLab ingress and the GitHub ingress feed the same PM. When upstream
 * changed which prompt a repo-host event wakes PM with, the GitLab path kept
 * the old one silently — no test held the two in step. This one does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedEventContext } from '../../../ports/repo-host-events.js';

const sendMessage = vi.fn();
const taskStub = { metadata: { repositories: {} }, sendMessage, debouncedSave: vi.fn() };

vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn(async () => taskStub) },
}));
vi.mock('../../../tasks/persistence.js', () => ({
  appendGitHubEvent: vi.fn(),
  findTaskByBranch: vi.fn(),
  findTaskByPRNumber: vi.fn(),
}));
vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: vi.fn(), plain: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: () => false }));

import { handleExistingTaskDirect } from '../events.js';
import { AGENT_PROMPTS } from '../../../agents/prompts.js';

const context = (over: Partial<NormalizedEventContext> = {}): NormalizedEventContext => ({
  eventType: 'pull_request',
  repo: 'group/api',
  prNumber: 9,
  ...over,
}) as NormalizedEventContext;

describe('handleExistingTaskDirect (GitLab)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wakes PM with the same prompt the GitHub ingress uses', async () => {
    await handleExistingTaskDirect('task-1', context());

    expect(sendMessage).toHaveBeenCalledWith(AGENT_PROMPTS.githubInput, 'pm-agent');
  });

  it('does not wake PM with the generic existingTask prompt, which PM cannot act on alone', async () => {
    await handleExistingTaskDirect('task-1', context());

    expect(sendMessage).not.toHaveBeenCalledWith(AGENT_PROMPTS.existingTask, 'pm-agent');
  });
});
