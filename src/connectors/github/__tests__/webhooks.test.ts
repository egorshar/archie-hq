import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeGitHubEvent } from '../webhooks.js';

vi.mock('../../../tasks/persistence.js', () => ({
  loadMetadata: vi.fn(),
  findTaskByPRNumber: vi.fn(),
  findTaskByBranch: vi.fn(),
  appendGitHubEvent: vi.fn(),
}));

import { loadMetadata, findTaskByPRNumber, findTaskByBranch } from '../../../tasks/persistence.js';

describe('routeGitHubEvent', () => {
  const repository = { full_name: 'org/repo' };
  const TASK_ID = 'task-20260714-1200-abc123';
  const OUR_BRANCH = `archie/${TASK_ID}`;

  beforeEach(() => {
    vi.mocked(loadMetadata).mockReset();
    vi.mocked(findTaskByPRNumber).mockReset();
    vi.mocked(findTaskByBranch).mockReset();
    delete process.env.GITHUB_APP_SLUG;
  });

  it('happy path: PR opened on our archie/ branch, task known → merge_check', async () => {
    vi.mocked(loadMetadata).mockResolvedValue({} as never);
    const result = await routeGitHubEvent('pull_request', {
      repository,
      sender: { login: 'dev1' },
      action: 'opened',
      pull_request: { number: 5, head: { ref: OUR_BRANCH } },
    });
    expect(result).toEqual({ action: 'direct', handler: 'merge_check', taskId: TASK_ID });
    expect(findTaskByBranch).not.toHaveBeenCalled();
  });

  it('routes git-flow ticket branches via findTaskByBranch (extractTaskIdFromBranch deliberately misses)', async () => {
    const TICKET_BRANCH = 'feature/SWEED-123-fix-auth-flow';
    vi.mocked(findTaskByBranch).mockResolvedValue(TASK_ID);
    vi.mocked(loadMetadata).mockResolvedValue({} as never);
    const result = await routeGitHubEvent('pull_request', {
      repository,
      sender: { login: 'dev1' },
      action: 'opened',
      pull_request: { number: 5, head: { ref: TICKET_BRANCH } },
    });
    expect(findTaskByBranch).toHaveBeenCalledWith('org/repo', TICKET_BRANCH);
    expect(findTaskByPRNumber).not.toHaveBeenCalled();
    expect(result).toEqual({ action: 'direct', handler: 'merge_check', taskId: TASK_ID });
  });

  it('not-our-branch (no taskId from branch, findTaskByBranch and PR-number lookup both miss) → discard', async () => {
    const result = await routeGitHubEvent('pull_request', {
      repository,
      sender: { login: 'dev1' },
      action: 'opened',
      pull_request: { number: 5, head: { ref: 'feature/unrelated-work' } },
    });
    expect(result).toMatchObject({ action: 'discard' });
    expect(loadMetadata).not.toHaveBeenCalled();
  });

  it('unknown task (branch resolves a taskId via findTaskByBranch, but metadata lookup misses) → discard', async () => {
    vi.mocked(findTaskByBranch).mockResolvedValue(TASK_ID);
    vi.mocked(loadMetadata).mockResolvedValue(null);
    const result = await routeGitHubEvent('pull_request', {
      repository,
      sender: { login: 'dev1' },
      action: 'opened',
      pull_request: { number: 5, head: { ref: 'feature/SWEED-123-fix-auth-flow' } },
    });
    expect(result).toMatchObject({ action: 'discard' });
    expect(loadMetadata).toHaveBeenCalledWith(TASK_ID);
  });
});
