/**
 * GitLabHost — the GitLab implementation of the RepoHost seam (design decision:
 * GitHub schema is canonical; GitLab responses are mapped into it). REST v4 only.
 * Read methods are implemented in Plan 1; write/review methods arrive in Plan 2.
 */

import type { RepoHost } from '../../ports/repo-host.js';
import type { RepoHostCapabilities } from '../../ports/capabilities.js';
import { GITLAB_CAPABILITIES_DEFAULT } from '../../ports/capabilities.js';
import type {
  PRStatus, PRReview, ReviewThread, PRComment, PRChecksReport,
  CreatePRResult, PRDetails, PRListItem, PRListFilters,
  CheckRunReport, WorkflowRunReport, CodeScanningAlert, CodeScanningAlertFilters,
} from '../../ports/repo-host-types.js';
import type { PrCardData } from '../../types/task.js';
import { logger } from '../../system/logger.js';
import { glRequest, glRequestAll } from './http.js';
import { mapDetailedMergeStatus, mapMrState, mapPipelineStatusToConclusion, parseGitLabCheckRef } from './status-map.js';

const NOT_IMPL = (name: string) => new Error(`GitLabHost.${name} not implemented until Plan 2`);

export class GitLabHost implements RepoHost {
  readonly kind = 'gitlab' as const;

  /** Capabilities start least-capable; the boot probe (Task 3) may raise them. */
  private caps: RepoHostCapabilities = { ...GITLAB_CAPABILITIES_DEFAULT };

  capabilities(): RepoHostCapabilities {
    return this.caps;
  }

  /** Overwrite capabilities from the license probe (Task 3). */
  setCapabilities(next: RepoHostCapabilities): void {
    this.caps = next;
  }

  /**
   * Detect the licensed tier via GET /license and raise capabilities accordingly.
   * Ultimate exposes the vulnerability API → securityAlerts=true. Free/CE returns
   * 403/404 → stay least-capable. Any failure defaults to least-capable (R2).
   */
  async probeCapabilities(): Promise<void> {
    try {
      const license = await glRequest<{ plan?: string }>({ path: '/license' });
      const plan = (license.plan ?? '').toLowerCase();
      if (plan === 'ultimate') {
        this.caps = { ...this.caps, securityAlerts: true };
      }
      logger.system(`GitLab: license plan=${plan || 'unknown'} → securityAlerts=${this.caps.securityAlerts}`);
    } catch {
      logger.system('GitLab: /license unavailable (Free/CE or restricted token) → capabilities stay least-capable');
    }
  }

  botIdentity(): { name: string; email: string } | null {
    const name = process.env.GITLAB_BOT_NAME;
    const email = process.env.GITLAB_BOT_EMAIL;
    if (!name || !email) return null;
    return { name, email };
  }

  cloneUrl(repo: string): string {
    const base = (process.env.GITLAB_BASE_URL ?? '').replace(/\/+$/, '');
    return `${base}/${repo}.git`;
  }

  async askpassToken(): Promise<string> {
    const t = process.env.GITLAB_TOKEN;
    if (!t) throw new Error('GITLAB_TOKEN is not set');
    return t;
  }

  /** URL-encoded project id for the `:id` path segment. */
  private projectId(repo: string): string {
    return encodeURIComponent(repo);
  }

  // ---- read methods: implemented in Tasks 4–6 (throw until then) ----
  async getPRStatus(_repo: string, _prNumber: number): Promise<PRStatus> { throw NOT_IMPL('getPRStatus'); }
  async getPRDetails(_repo: string, _prNumber: number): Promise<PRDetails> { throw NOT_IMPL('getPRDetails'); }
  async getPRCardData(_repo: string, _prNumber: number): Promise<PrCardData> { throw NOT_IMPL('getPRCardData'); }
  async listPRs(_repo: string, _filters?: PRListFilters): Promise<PRListItem[]> { throw NOT_IMPL('listPRs'); }
  async getPRComments(_repo: string, _prNumber: number): Promise<PRComment[]> { throw NOT_IMPL('getPRComments'); }
  async listPRChecks(_repo: string, _prNumber: number): Promise<PRChecksReport> { throw NOT_IMPL('listPRChecks'); }
  async getCheckRunById(_repo: string, _checkRunId: number): Promise<CheckRunReport> { throw NOT_IMPL('getCheckRunById'); }
  async getWorkflowRunById(_repo: string, _runId: number): Promise<WorkflowRunReport> { throw NOT_IMPL('getWorkflowRunById'); }
  async listAccessibleRepos(): Promise<Array<{ github: string; default_branch: string; description?: string }>> { throw NOT_IMPL('listAccessibleRepos'); }
  async resolveRepo(_repo: string): Promise<{ default_branch: string } | null> { throw NOT_IMPL('resolveRepo'); }

  // ---- write/review methods: implemented in Plan 2 (throw for now) ----
  async createPullRequest(): Promise<CreatePRResult> { throw NOT_IMPL('createPullRequest'); }
  async updatePR(): Promise<void> { throw NOT_IMPL('updatePR'); }
  async addPRComment(): Promise<void> { throw NOT_IMPL('addPRComment'); }
  async closePullRequest(): Promise<void> { throw NOT_IMPL('closePullRequest'); }
  async mergePullRequest(): Promise<{ success: boolean; message: string }> { throw NOT_IMPL('mergePullRequest'); }
  async pushBranch(): Promise<{ success: boolean; message: string }> { throw NOT_IMPL('pushBranch'); }
  async getPRReviews(): Promise<PRReview[]> { throw NOT_IMPL('getPRReviews'); }
  async getReviewThreads(): Promise<ReviewThread[]> { throw NOT_IMPL('getReviewThreads'); }
  async addReviewComment(): Promise<void> { throw NOT_IMPL('addReviewComment'); }
  async replyToReviewComment(): Promise<void> { throw NOT_IMPL('replyToReviewComment'); }
  async resolveReviewThread(): Promise<void> { throw NOT_IMPL('resolveReviewThread'); }
  async requestReReview(): Promise<void> { throw NOT_IMPL('requestReReview'); }
  async listCodeScanningAlerts(_repo: string, _filters?: CodeScanningAlertFilters): Promise<CodeScanningAlert[]> { throw NOT_IMPL('listCodeScanningAlerts'); }
  async getCodeScanningAlert(_repo: string, _alertNumber: number): Promise<CodeScanningAlert> { throw NOT_IMPL('getCodeScanningAlert'); }
}
