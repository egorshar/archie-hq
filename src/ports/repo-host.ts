/**
 * RepoHost — the repo-host seam (spec §3.1). One implementation per host:
 * GitHubHost (GitHubClient) today; GitLabHost in Phase 1. Method names keep the
 * current PR-oriented vocabulary (1:1 with GitHubClient); neutral CR renaming is
 * Phase 4. All methods take the host repo identifier `repo` as "owner/name".
 */

import type { RepoHostCapabilities } from './capabilities.js';
import type {
  PRStatus,
  PRReview,
  ReviewThread,
  PRComment,
  PRChecksReport,
} from './repo-host-types.js';
import type {
  CreatePRResult,
  PRDetails,
  PRListItem,
  PRListFilters,
  CheckRunReport,
  WorkflowRunReport,
  CodeScanningAlert,
  CodeScanningAlertFilters,
} from '../connectors/github/client.js';
import type { PrCardData } from '../types/task.js';

export interface RepoHost {
  readonly kind: 'github' | 'gitlab';
  capabilities(): RepoHostCapabilities;
  botIdentity(): { name: string; email: string } | null;
  cloneUrl(repo: string): string;
  /** Optional in Phase 0 — not yet wired into the GIT_ASKPASS flow (Phase 1). */
  askpassToken?(): Promise<string>;

  // change requests (PR / MR)
  createPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<CreatePRResult>;
  getPRStatus(repo: string, prNumber: number): Promise<PRStatus>;
  getPRDetails(repo: string, prNumber: number): Promise<PRDetails>;
  getPRCardData(repo: string, prNumber: number): Promise<PrCardData>;
  listPRs(repo: string, filters?: PRListFilters): Promise<PRListItem[]>;
  updatePR(repo: string, prNumber: number, fields: { title?: string; body?: string; base?: string }): Promise<void>;
  addPRComment(repo: string, prNumber: number, comment: string): Promise<void>;
  getPRComments(repo: string, prNumber: number): Promise<PRComment[]>;
  closePullRequest(repo: string, prNumber: number): Promise<void>;
  mergePullRequest(repo: string, prNumber: number, mergeMethod?: 'merge' | 'squash' | 'rebase'): Promise<{ success: boolean; message: string }>;
  pushBranch(repo: string, branch: string, worktreePath: string): Promise<{ success: boolean; message: string }>;

  // reviews
  getPRReviews(repo: string, prNumber: number): Promise<PRReview[]>;
  getReviewThreads(repo: string, prNumber: number): Promise<ReviewThread[]>;
  addReviewComment(repo: string, prNumber: number, path: string, line: number, comment: string): Promise<void>;
  replyToReviewComment(repo: string, prNumber: number, commentId: number, comment: string): Promise<void>;
  resolveReviewThread(repo: string, prNumber: number, threadId: string): Promise<void>;
  requestReReview(repo: string, prNumber: number): Promise<void>;

  // CI
  listPRChecks(repo: string, prNumber: number): Promise<PRChecksReport>;
  getCheckRunById(repo: string, checkRunId: number): Promise<CheckRunReport>;
  getWorkflowRunById(repo: string, runId: number): Promise<WorkflowRunReport>;

  // repos
  listAccessibleRepos(): Promise<Array<{ github: string; default_branch: string; description?: string }>>;
  resolveRepo(repo: string): Promise<{ default_branch: string } | null>;

  // security (flat in Phase 0; capability-gated sub-object in Phase 1)
  listCodeScanningAlerts(repo: string, filters?: CodeScanningAlertFilters): Promise<CodeScanningAlert[]>;
  getCodeScanningAlert(repo: string, alertNumber: number): Promise<CodeScanningAlert>;
}
