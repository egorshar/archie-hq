# Phase 1 · GitLab Host — Plan 1: Config, Capability Probe & Read-Side Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED READING before Task 1** (defines the contract you implement — do not invent a parallel abstraction):
> - `docs/plans/2026-07-06-phase-1-gitlab-host-design.md` — the Phase 1 design (decisions, mappings, scope).
> - `docs/architecture/backends.md` — the backend-abstraction seam.
> - `src/ports/repo-host.ts`, `src/ports/repo-host-types.ts`, `src/ports/capabilities.ts` — the exact `RepoHost` interface + canonical (GitHub-shaped) data types GitLab maps into.
> - `src/connectors/github/client.ts` — the reference implementation whose method semantics and logging conventions this mirrors.

**Goal:** Stand up `REPO_HOST=gitlab` with a `GitLabHost` that boots, validates its env, probes its licensed tier for capabilities, and implements every read-side `RepoHost` method against GitLab REST v4 — with the default GitHub path unchanged.

**Architecture:** New `src/connectors/gitlab/` connector, mirroring `connectors/github/`. `GitLabHost implements RepoHost` maps GitLab REST responses into the canonical `ports/repo-host-types.ts` shapes (GitHub schema as lingua franca). All GitLab HTTP calls funnel through one `glRequest()` helper so the vendor surface is confined to this directory. `src/system/backends.ts` gains a `gitlab` branch. Write/action methods, reviews, webhooks, clone/askpass, and docs are Plans 2–4.

**Tech Stack:** Node ≥20 (ESM, `"type":"module"`, `.js` import specifiers), TypeScript, Vitest ^4. GitLab access via the built-in global `fetch` against `${GITLAB_BASE_URL}/api/v4` with a `PRIVATE-TOKEN` header — no new dependency.

## Global Constraints

- **Additive / zero behavior change (P1).** No task changes the GitHub or Claude path. The full suite (`npm test`) passes **unmodified** after every task; existing tests may not be edited. Default config stays `REPO_HOST=github`.
- **Vendor isolation (acceptance gate).** After Plan 1: `grep -rn "api/v4" src --include="*.ts" | grep -v "connectors/gitlab"` → empty. No GitLab HTTP call lives outside `src/connectors/gitlab/`.
- **Canonical schema.** GitLab methods return the exact `ports/repo-host-types.ts` shapes — never GitLab-native structs. `repo` is always `"group/project"`; URL-encode it for the `:id` path segment via `encodeURIComponent`. MR number is the `iid`.
- **Least-capable default.** `securityAlerts` defaults to `false` and is only raised by a successful license probe (spec R2). Never assume a tier.
- **Logging.** Never `console.*`. Use `logger` from `src/system/logger.ts` (category first, e.g. `logger.system(...)`, `logger.warn('gitlab', ...)`).
- **Prose wrapping.** One line per paragraph/bullet in Markdown/comments; only code may span fixed-width lines.
- **Commits.** Atomic, one logical change per commit. Commit at the end of each task (commits authorized for this plan; do not push).

## File Structure

New files:
- `src/connectors/gitlab/http.ts` — `glRequest()` fetch wrapper (auth, base URL, JSON, error normalization, `PRIVATE-TOKEN`).
- `src/connectors/gitlab/status-map.ts` — pure mappers: `mapDetailedMergeStatus`, `mapPipelineStatusToConclusion`, `mapMrState`, `parseGitLabCheckRef`.
- `src/connectors/gitlab/client.ts` — `class GitLabHost implements RepoHost` (read-side methods this plan; write/review methods stubbed to `throw new Error('not implemented (Plan 2)')`).
- `src/connectors/gitlab/__tests__/status-map.test.ts`
- `src/connectors/gitlab/__tests__/client-read.test.ts`
- `src/system/__tests__/backends-gitlab.test.ts`

Modified files:
- `src/ports/capabilities.ts` — add `GITLAB_CAPABILITIES_DEFAULT`.
- `src/system/backends.ts` — `SUPPORTED_REPO_HOSTS += 'gitlab'`, env validation, `getRepoHost()` gitlab branch, singleton + boot capability probe.

## Task dependency order

Task 1 (status-map, pure) → Task 2 (http + GitLabHost skeleton) → Task 3 (capabilities default + probe) → Task 4 (MR read methods) → Task 5 (CI read methods) → Task 6 (repos + card) → Task 7 (backends wiring + boot). Tasks 1–6 are unit-testable with mocked `fetch`; Task 7 wires the resolver and is the integration point.

---

## Task 1: Pure status/ref mappers — `status-map.ts`

**Files:**
- Create: `src/connectors/gitlab/status-map.ts`
- Create: `src/connectors/gitlab/__tests__/status-map.test.ts`

**Interfaces:**
- Consumes: `MergeableState`, `CheckConclusion` from `src/ports/repo-host-types.js`.
- Produces: `mapDetailedMergeStatus(s: string): MergeableState`, `mapPipelineStatusToConclusion(s: string): CheckConclusion`, `mapMrState(state: string, merged?: boolean): 'open'|'merged'|'closed'`, `parseGitLabCheckRef(input: string): { kind: 'job'|'pipeline'; id: number } | null`. Consumed by Tasks 4–6.

- [ ] **Step 1: Write the failing test.** Create `src/connectors/gitlab/__tests__/status-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  mapDetailedMergeStatus,
  mapPipelineStatusToConclusion,
  mapMrState,
  parseGitLabCheckRef,
} from '../status-map.js';

describe('mapDetailedMergeStatus', () => {
  it('mergeable → clean', () => {
    expect(mapDetailedMergeStatus('mergeable')).toBe('clean');
  });
  it('conflict/broken_status → dirty', () => {
    expect(mapDetailedMergeStatus('conflict')).toBe('dirty');
    expect(mapDetailedMergeStatus('broken_status')).toBe('dirty');
  });
  it('ci_still_running/preparing/checking/unchecked → unstable', () => {
    for (const s of ['ci_still_running', 'preparing', 'checking', 'unchecked']) {
      expect(mapDetailedMergeStatus(s)).toBe('unstable');
    }
  });
  it('approval/discussion/draft/blocked/rebase gates → blocked', () => {
    for (const s of ['not_approved', 'discussions_not_resolved', 'draft_status', 'blocked_status', 'not_open', 'need_rebase']) {
      expect(mapDetailedMergeStatus(s)).toBe('blocked');
    }
  });
  it('unknown value → unknown', () => {
    expect(mapDetailedMergeStatus('something_new')).toBe('unknown');
    expect(mapDetailedMergeStatus('')).toBe('unknown');
  });
});

describe('mapPipelineStatusToConclusion', () => {
  it('maps terminal statuses', () => {
    expect(mapPipelineStatusToConclusion('success')).toBe('success');
    expect(mapPipelineStatusToConclusion('failed')).toBe('failure');
    expect(mapPipelineStatusToConclusion('canceled')).toBe('cancelled');
    expect(mapPipelineStatusToConclusion('skipped')).toBe('skipped');
  });
  it('maps in-progress/created to null (no conclusion yet)', () => {
    for (const s of ['running', 'pending', 'created', 'manual', 'scheduled', 'waiting_for_resource', 'preparing']) {
      expect(mapPipelineStatusToConclusion(s)).toBeNull();
    }
  });
});

describe('mapMrState', () => {
  it('opened → open, merged → merged, closed/locked → closed', () => {
    expect(mapMrState('opened')).toBe('open');
    expect(mapMrState('merged')).toBe('merged');
    expect(mapMrState('closed')).toBe('closed');
    expect(mapMrState('locked')).toBe('closed');
  });
  it('merged flag overrides state', () => {
    expect(mapMrState('opened', true)).toBe('merged');
  });
});

describe('parseGitLabCheckRef', () => {
  it('parses a job URL', () => {
    expect(parseGitLabCheckRef('https://gl.example/group/proj/-/jobs/12345')).toEqual({ kind: 'job', id: 12345 });
  });
  it('parses a pipeline URL', () => {
    expect(parseGitLabCheckRef('https://gl.example/group/proj/-/pipelines/999')).toEqual({ kind: 'pipeline', id: 999 });
  });
  it('parses a bare numeric id as a job', () => {
    expect(parseGitLabCheckRef('4242')).toEqual({ kind: 'job', id: 4242 });
  });
  it('returns null for an unparseable ref', () => {
    expect(parseGitLabCheckRef('not-a-ref')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**

Run: `npx vitest run src/connectors/gitlab/__tests__/status-map.test.ts`
Expected: FAIL — cannot find module `../status-map.js`.

- [ ] **Step 3: Implement `src/connectors/gitlab/status-map.ts`.**

```ts
/**
 * Pure GitLab → canonical mappers (spec §5 Phase 1, design decision 4). Kept
 * network-free so they are unit-testable in isolation. GitLab's vocabulary is
 * translated into the canonical GitHub-shaped types in ports/repo-host-types.ts.
 */

import type { MergeableState, CheckConclusion } from '../../ports/repo-host-types.js';

/** GitLab MR `detailed_merge_status` → canonical MergeableState. */
export function mapDetailedMergeStatus(status: string): MergeableState {
  switch (status) {
    case 'mergeable':
      return 'clean';
    case 'conflict':
    case 'broken_status':
      return 'dirty';
    case 'ci_still_running':
    case 'preparing':
    case 'checking':
    case 'unchecked':
      return 'unstable';
    case 'not_approved':
    case 'discussions_not_resolved':
    case 'draft_status':
    case 'blocked_status':
    case 'not_open':
    case 'need_rebase':
      return 'blocked';
    default:
      return 'unknown';
  }
}

/** GitLab pipeline/job `status` → canonical CheckConclusion (null = no conclusion yet). */
export function mapPipelineStatusToConclusion(status: string): CheckConclusion {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      // running, pending, created, manual, scheduled, waiting_for_resource, preparing…
      return null;
  }
}

/** GitLab MR `state` (+ optional merged flag) → canonical PR state. */
export function mapMrState(state: string, merged?: boolean): 'open' | 'merged' | 'closed' {
  if (merged || state === 'merged') return 'merged';
  if (state === 'opened') return 'open';
  return 'closed'; // closed | locked | anything else
}

/**
 * Parse a GitLab job/pipeline reference (URL or bare id) for the check tools.
 * `/-/jobs/:id` → job; `/-/pipelines/:id` → pipeline; a bare number → job.
 */
export function parseGitLabCheckRef(input: string): { kind: 'job' | 'pipeline'; id: number } | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return { kind: 'job', id: Number(trimmed) };
  }
  const job = trimmed.match(/\/-\/jobs\/(\d+)/);
  if (job) return { kind: 'job', id: Number(job[1]) };
  const pipeline = trimmed.match(/\/-\/pipelines\/(\d+)/);
  if (pipeline) return { kind: 'pipeline', id: Number(pipeline[1]) };
  return null;
}
```

- [ ] **Step 4: Run it, verify it passes.**

Run: `npx vitest run src/connectors/gitlab/__tests__/status-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/status-map.ts src/connectors/gitlab/__tests__/status-map.test.ts
git commit -m "feat(gitlab): pure status/ref mappers (detailed_merge_status, pipeline, check-ref)"
```

---

## Task 2: HTTP helper + `GitLabHost` skeleton

**Files:**
- Create: `src/connectors/gitlab/http.ts`
- Create: `src/connectors/gitlab/client.ts`
- Create: `src/connectors/gitlab/__tests__/client-read.test.ts` (skeleton assertions only this task)

**Interfaces:**
- Consumes: `RepoHost` (`src/ports/repo-host.js`), `RepoHostCapabilities` + `GITLAB_CAPABILITIES_DEFAULT` (Task 3 adds the constant — this task imports it; do Task 3's Step 3 constant first if needed, or inline a local default and replace in Task 3). `logger`.
- Produces: `glRequest(opts)`, `class GitLabHost implements RepoHost` with infra members (`kind`, `capabilities`, `botIdentity`, `cloneUrl`, `projectId`) and all `RepoHost` methods present (read ones stubbed until Tasks 4–6; write ones `throw`). Consumed by Tasks 3–7.

> Note: `GitLabHost` must satisfy the whole `RepoHost` interface for `implements` to typecheck, so every method exists from this task — read methods get real bodies in Tasks 4–6, write/review methods throw `Error('GitLabHost.<name> not implemented until Plan 2')`. The throw is temporary scaffolding, not a placeholder in the plan sense: the code is complete and compiles.

- [ ] **Step 1: Implement `src/connectors/gitlab/http.ts`.**

```ts
/**
 * The single seam through which every GitLab REST v4 call flows, so the vendor
 * surface stays confined to src/connectors/gitlab/. Auth is a group/project
 * access token sent as PRIVATE-TOKEN (spec D1). Base URL comes from GITLAB_BASE_URL.
 */

import { logger } from '../../system/logger.js';

export interface GlRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path under /api/v4, e.g. `/projects/${encodeURIComponent(repo)}/merge_requests/${iid}`. */
  path: string;
  /** Query params; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST/PUT. */
  body?: unknown;
  /** When true, return the raw text body (used for job trace). Default: parse JSON. */
  raw?: boolean;
}

function baseUrl(): string {
  const url = process.env.GITLAB_BASE_URL;
  if (!url) throw new Error('GITLAB_BASE_URL is not set');
  return url.replace(/\/+$/, '');
}

function token(): string {
  const t = process.env.GITLAB_TOKEN;
  if (!t) throw new Error('GITLAB_TOKEN is not set');
  return t;
}

/** Perform a GitLab REST call. Throws on non-2xx with a compact message. */
export async function glRequest<T = unknown>(opts: GlRequestOptions): Promise<T> {
  const url = new URL(`${baseUrl()}/api/v4${opts.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { 'PRIVATE-TOKEN': token() };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(opts.body);
  }

  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body: bodyInit });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn('gitlab', `${opts.method ?? 'GET'} ${opts.path} → ${res.status}`);
    throw new Error(`GitLab ${opts.method ?? 'GET'} ${opts.path} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  if (opts.raw) return (await res.text()) as unknown as T;
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Read a paginated GitLab collection, following `x-next-page` up to `maxPages`. */
export async function glRequestAll<T = unknown>(opts: GlRequestOptions, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (; page <= maxPages; page++) {
    const url = new URL(`${baseUrl()}/api/v4${opts.path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token() } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab GET ${opts.path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    out.push(...((await res.json()) as T[]));
    const next = res.headers.get('x-next-page');
    if (!next) break;
  }
  return out;
}
```

- [ ] **Step 2: Implement `src/connectors/gitlab/client.ts` skeleton.**

```ts
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
```

> The unused imports (`glRequest`, `mapMrState`, etc.) are consumed in Tasks 4–6. If your linter fails the build on unused imports, add them method-by-method instead; this repo's `tsc` config does not error on unused imports (verify with Step 3).

- [ ] **Step 3: Write the skeleton test.** Create `src/connectors/gitlab/__tests__/client-read.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GitLabHost } from '../client.js';

describe('GitLabHost skeleton', () => {
  it('reports kind gitlab and least-capable defaults', () => {
    const host = new GitLabHost();
    expect(host.kind).toBe('gitlab');
    expect(host.capabilities().securityAlerts).toBe(false);
  });

  it('builds a clone URL from GITLAB_BASE_URL', () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    const host = new GitLabHost();
    expect(host.cloneUrl('group/proj')).toBe('https://gl.example/group/proj.git');
  });
});
```

- [ ] **Step 4: Typecheck + run tests.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts`
Expected: PASS. If `implements RepoHost` fails, a method signature diverges from `src/ports/repo-host.ts` — reconcile against the interface (do not change the interface).

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/http.ts src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-read.test.ts
git commit -m "feat(gitlab): REST http helper + GitLabHost skeleton conforming to RepoHost"
```

---

## Task 3: Capability default + license probe

**Files:**
- Modify: `src/ports/capabilities.ts` (add `GITLAB_CAPABILITIES_DEFAULT`)
- Modify: `src/connectors/gitlab/client.ts` (add `probeCapabilities()`)
- Modify: `src/connectors/gitlab/__tests__/client-read.test.ts` (add probe tests)

**Interfaces:**
- Produces: `GITLAB_CAPABILITIES_DEFAULT: RepoHostCapabilities`; `GitLabHost.probeCapabilities(): Promise<void>` (calls `GET /license`, raises `securityAlerts` on Ultimate). Consumed by Task 7's boot wiring.

- [ ] **Step 1: Add the default constant to `src/ports/capabilities.ts`.** After `GITHUB_CAPABILITIES`:

```ts
/**
 * GitLab defaults — least-capable baseline. reviewStates is false (GitLab has
 * approvals + notes, not distinct approved/changes_requested states — synthesized
 * in Plan 2). securityAlerts starts false and is raised only when the boot-time
 * /license probe reports an Ultimate tier (spec R2). nativeAutoMerge exists
 * ("merge when pipeline succeeds") but Archie keeps orchestrating by default.
 */
export const GITLAB_CAPABILITIES_DEFAULT: RepoHostCapabilities = {
  reviewStates: false,
  securityAlerts: false,
  nativeAutoMerge: true,
  reReviewRequest: false,
};
```

- [ ] **Step 2: Add the probe test.** Append to `src/connectors/gitlab/__tests__/client-read.test.ts`:

```ts
import { vi, afterEach } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('GitLabHost.probeCapabilities', () => {
  it('raises securityAlerts when /license reports Ultimate', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ plan: 'ultimate' }), { status: 200 })
    ));
    const host = new GitLabHost();
    await host.probeCapabilities();
    expect(host.capabilities().securityAlerts).toBe(true);
  });

  it('leaves securityAlerts false when /license is forbidden (Free/CE)', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    const host = new GitLabHost();
    await host.probeCapabilities();
    expect(host.capabilities().securityAlerts).toBe(false);
  });
});
```

- [ ] **Step 3: Run it, verify it fails.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts -t probeCapabilities`
Expected: FAIL — `host.probeCapabilities is not a function`.

- [ ] **Step 4: Implement `probeCapabilities()` in `client.ts`** (add the method inside the class, after `setCapabilities`):

```ts
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
```

- [ ] **Step 5: Run tests + typecheck.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/ports/capabilities.ts src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-read.test.ts
git commit -m "feat(gitlab): least-capable defaults + /license capability probe (R2)"
```

---

## Task 4: MR read methods — status, details, list, comments

**Files:**
- Modify: `src/connectors/gitlab/client.ts` (implement `getPRStatus`, `getPRDetails`, `listPRs`, `getPRComments`)
- Modify: `src/connectors/gitlab/__tests__/client-read.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll`, `mapDetailedMergeStatus`, `mapMrState` (Tasks 1–2).
- Produces: real bodies for `getPRStatus`, `getPRDetails`, `listPRs`, `getPRComments` returning canonical shapes.

- [ ] **Step 1: Write the failing tests.** Append to `client-read.test.ts`:

```ts
function mockFetchOnce(json: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(json), { status, headers }));
}

describe('GitLabHost.getPRStatus', () => {
  it('maps MR + approvals into canonical PRStatus', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    const fetchMock = vi.fn()
      // MR
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 7, state: 'opened', merged: false, detailed_merge_status: 'mergeable',
      }), { status: 200 }))
      // approvals
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const status = await host.getPRStatus('group/proj', 7);
    expect(status).toEqual({ state: 'open', mergeable: true, mergeableState: 'clean', approved: true });
  });

  it('marks non-clean detailed_merge_status as not mergeable', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        iid: 7, state: 'opened', merged: false, detailed_merge_status: 'conflict',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: false }), { status: 200 })));
    const host = new GitLabHost();
    const status = await host.getPRStatus('group/proj', 7);
    expect(status.mergeableState).toBe('dirty');
    expect(status.mergeable).toBe(false);
  });
});

describe('GitLabHost.getPRComments', () => {
  it('maps MR notes into canonical PRComment[]', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce([
      { id: 1, author: { username: 'alice' }, body: 'hi', created_at: '2026-01-01T00:00:00Z', system: false },
      { id: 2, author: { username: 'bot' }, body: 'x', created_at: '2026-01-01T00:01:00Z', system: true },
    ]));
    const host = new GitLabHost();
    const comments = await host.getPRComments('group/proj', 7);
    expect(comments).toHaveLength(1); // system note filtered out
    expect(comments[0]).toMatchObject({ id: 1, author: 'alice', body: 'hi' });
  });
});
```

- [ ] **Step 2: Run, verify failure.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts -t getPRStatus`
Expected: FAIL — throws `not implemented`.

- [ ] **Step 3: Implement the four methods** (replace the corresponding stubs in `client.ts`):

```ts
async getPRStatus(repo: string, prNumber: number): Promise<PRStatus> {
  const id = this.projectId(repo);
  const mr = await glRequest<{ state: string; merged?: boolean; detailed_merge_status?: string }>({
    path: `/projects/${id}/merge_requests/${prNumber}`,
  });
  const approvals = await glRequest<{ approved?: boolean }>({
    path: `/projects/${id}/merge_requests/${prNumber}/approvals`,
  }).catch(() => ({ approved: false }));

  const mergeableState = mapDetailedMergeStatus(mr.detailed_merge_status ?? '');
  const status: PRStatus = {
    state: mapMrState(mr.state, mr.merged),
    mergeable: mergeableState === 'clean',
    mergeableState,
    approved: approvals.approved === true,
  };
  logger.system(`GitLab: MR !${prNumber} status: state=${status.state} mergeableState=${status.mergeableState} approved=${status.approved} (raw detailed_merge_status=${mr.detailed_merge_status})`);
  return status;
}

async getPRDetails(repo: string, prNumber: number): Promise<PRDetails> {
  const id = this.projectId(repo);
  const mr = await glRequest<{
    iid: number; title: string; description: string | null; state: string; merged?: boolean;
    source_branch: string; target_branch: string; web_url: string;
  }>({ path: `/projects/${id}/merge_requests/${prNumber}` });
  const changes = await glRequest<{ changes?: Array<{ diff?: string; old_path?: string; new_path?: string }> }>({
    path: `/projects/${id}/merge_requests/${prNumber}/changes`,
  }).catch(() => ({ changes: [] }));
  const diff = (changes.changes ?? [])
    .map((c) => `--- ${c.old_path ?? ''}\n+++ ${c.new_path ?? ''}\n${c.diff ?? ''}`)
    .join('\n');
  return {
    number: prNumber,
    title: mr.title,
    body: mr.description ?? '',
    state: mapMrState(mr.state, mr.merged),
    head: mr.source_branch,
    base: mr.target_branch,
    diff,
    url: mr.web_url,
  };
}

async listPRs(repo: string, filters: PRListFilters = {}): Promise<PRListItem[]> {
  const id = this.projectId(repo);
  // Canonical filters.state is open|closed|all; GitLab uses opened|closed|merged|all.
  const stateMap: Record<string, string> = { open: 'opened', closed: 'closed', all: 'all' };
  const items = await glRequestAll<{
    iid: number; title: string; state: string; merged?: boolean;
    source_branch: string; target_branch: string; author?: { username?: string };
    updated_at: string; web_url: string;
  }>({
    path: `/projects/${id}/merge_requests`,
    query: {
      state: stateMap[filters.state ?? 'open'] ?? 'opened',
      target_branch: filters.base,
      order_by: 'updated_at',
      sort: filters.direction ?? 'desc',
    },
  }, 1);
  const limit = filters.per_page ?? 10;
  return items.slice(0, limit).map((mr) => ({
    number: mr.iid,
    title: mr.title,
    state: mr.state === 'opened' ? 'open' : 'closed',
    head: mr.source_branch,
    base: mr.target_branch,
    author: mr.author?.username ?? 'unknown',
    updated_at: mr.updated_at,
    url: mr.web_url,
  }));
}

async getPRComments(repo: string, prNumber: number): Promise<PRComment[]> {
  const id = this.projectId(repo);
  const notes = await glRequestAll<{
    id: number; author?: { username?: string }; body: string; created_at: string;
    system?: boolean; noteable_type?: string;
  }>({ path: `/projects/${id}/merge_requests/${prNumber}/notes`, query: { sort: 'asc', order_by: 'created_at' } });
  return notes
    .filter((n) => !n.system)
    .map((n) => ({
      id: n.id,
      author: n.author?.username ?? 'unknown',
      body: n.body,
      createdAt: n.created_at,
      url: `${this.cloneUrl(repo).replace(/\.git$/, '')}/-/merge_requests/${prNumber}#note_${n.id}`,
    }));
}
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-read.test.ts
git commit -m "feat(gitlab): MR read methods (status, details, list, comments)"
```

---

## Task 5: CI read methods — checks, check-by-id, run-by-id, log tail

**Files:**
- Modify: `src/connectors/gitlab/client.ts` (implement `listPRChecks`, `getCheckRunById`, `getWorkflowRunById`; add private `fetchJobLogTail`)
- Modify: `src/connectors/gitlab/__tests__/client-read.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll`, `mapPipelineStatusToConclusion`, `parseGitLabCheckRef`.
- Produces: `listPRChecks` → `PRChecksReport`; `getCheckRunById(repo, jobId)` → `CheckRunReport`; `getWorkflowRunById(repo, pipelineId)` → `WorkflowRunReport`. `PRCheckEntry.source` is `'check_run'` for GitLab jobs (canonical union is `'check_run' | 'status'`).

- [ ] **Step 1: Write the failing tests.** Append to `client-read.test.ts`:

```ts
describe('GitLabHost.listPRChecks', () => {
  it('maps the latest pipeline jobs into a PRChecksReport', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn()
      // MR (for head sha + pipeline)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sha: 'abc123', head_pipeline: { id: 55 },
      }), { status: 200 }))
      // pipeline jobs
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, name: 'build', status: 'success', stage: 'build', web_url: 'u1', started_at: null, finished_at: null },
        { id: 2, name: 'test', status: 'failed', stage: 'test', web_url: 'u2', started_at: null, finished_at: null },
      ]), { status: 200 })));

    const host = new GitLabHost();
    const report = await host.listPRChecks('group/proj', 7);
    expect(report.headSha).toBe('abc123');
    expect(report.entries).toHaveLength(2);
    expect(report.entries[1]).toMatchObject({ name: 'test', conclusion: 'failure', source: 'check_run' });
  });
});
```

- [ ] **Step 2: Run, verify failure.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts -t listPRChecks`
Expected: FAIL — throws `not implemented`.

- [ ] **Step 3: Implement the CI methods** (replace stubs in `client.ts`):

```ts
private async fetchJobLogTail(repo: string, jobId: number): Promise<string | undefined> {
  try {
    const trace = await glRequest<string>({
      path: `/projects/${this.projectId(repo)}/jobs/${jobId}/trace`, raw: true,
    });
    if (!trace) return undefined;
    // Mirror the GitHub connector: prefer the tail from the first "Failures:" marker.
    const marker = trace.indexOf('Failures:');
    const slice = marker >= 0 ? trace.slice(marker) : trace;
    return slice.length > 3000 ? slice.slice(-3000) : slice;
  } catch {
    return undefined;
  }
}

async listPRChecks(repo: string, prNumber: number): Promise<PRChecksReport> {
  const id = this.projectId(repo);
  const mr = await glRequest<{ sha: string; head_pipeline?: { id: number } }>({
    path: `/projects/${id}/merge_requests/${prNumber}`,
  });
  if (!mr.head_pipeline) {
    return { headSha: mr.sha ?? '', entries: [] };
  }
  const jobs = await glRequestAll<{
    id: number; name: string; status: string; stage: string; web_url: string | null;
    started_at: string | null; finished_at: string | null;
  }>({ path: `/projects/${id}/pipelines/${mr.head_pipeline.id}/jobs` });

  return {
    headSha: mr.sha ?? '',
    entries: jobs.map((j) => ({
      source: 'check_run' as const,
      name: j.name,
      app: j.stage,
      status: j.status,
      conclusion: mapPipelineStatusToConclusion(j.status),
      url: j.web_url,
      startedAt: j.started_at,
      completedAt: j.finished_at,
    })),
  };
}

async getCheckRunById(repo: string, checkRunId: number): Promise<CheckRunReport> {
  const id = this.projectId(repo);
  const job = await glRequest<{
    id: number; name: string; stage: string; status: string; web_url: string | null;
    commit?: { id?: string }; started_at: string | null; finished_at: string | null;
  }>({ path: `/projects/${id}/jobs/${checkRunId}` });
  const conclusion = mapPipelineStatusToConclusion(job.status);
  const logTail = conclusion === 'failure' ? await this.fetchJobLogTail(repo, job.id) : undefined;
  return {
    id: job.id,
    name: job.name,
    app: job.stage,
    status: job.status,
    conclusion,
    url: job.web_url,
    headSha: job.commit?.id ?? null,
    startedAt: job.started_at,
    completedAt: job.finished_at,
    logTail,
  };
}

async getWorkflowRunById(repo: string, runId: number): Promise<WorkflowRunReport> {
  const id = this.projectId(repo);
  const pipeline = await glRequest<{ id: number; status: string; sha: string | null; ref: string | null; web_url: string | null }>({
    path: `/projects/${id}/pipelines/${runId}`,
  });
  const jobs = await glRequestAll<{ id: number; name: string; status: string; web_url: string | null }>({
    path: `/projects/${id}/pipelines/${runId}/jobs`,
  });
  const jobEntries = [] as WorkflowRunReport['jobs'];
  for (const j of jobs) {
    const conclusion = mapPipelineStatusToConclusion(j.status);
    jobEntries.push({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion,
      url: j.web_url,
      logTail: conclusion === 'failure' ? await this.fetchJobLogTail(repo, j.id) : undefined,
    });
  }
  return {
    id: pipeline.id,
    name: `pipeline #${pipeline.id}`,
    status: pipeline.status,
    conclusion: mapPipelineStatusToConclusion(pipeline.status),
    headSha: pipeline.sha,
    headBranch: pipeline.ref,
    url: pipeline.web_url,
    jobs: jobEntries,
  };
}
```

> `parseGitLabCheckRef` is used by the check tool (in `agents/tools.ts`) to decide job vs pipeline before calling `getCheckRunById`/`getWorkflowRunById`; wiring that tool-side dispatch is Plan 3 (webhooks/tools), not this task. It is exported and unit-tested here so it is ready.

- [ ] **Step 4: Run tests + typecheck.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-read.test.ts
git commit -m "feat(gitlab): CI read methods (pipeline checks, job/pipeline by id, log tail)"
```

---

## Task 6: Repo listing + PR card data

**Files:**
- Modify: `src/connectors/gitlab/client.ts` (implement `listAccessibleRepos`, `resolveRepo`, `getPRCardData`)
- Modify: `src/connectors/gitlab/__tests__/client-read.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll`, `summarizeCi` from `src/system/pr-card-format.js`, `PrCardData` from `src/types/task.js`.
- Produces: `listAccessibleRepos()` (`github` field = `group/project`), `resolveRepo()`, `getPRCardData()`.

- [ ] **Step 1: Write the failing tests.** Append to `client-read.test.ts`:

```ts
describe('GitLabHost.listAccessibleRepos', () => {
  it('maps projects to the canonical repo shape (github = group/project)', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce([
      { path_with_namespace: 'group/backend', default_branch: 'main', description: 'svc' },
      { path_with_namespace: 'group/mobile', default_branch: 'develop', description: null },
    ]));
    const host = new GitLabHost();
    const repos = await host.listAccessibleRepos();
    expect(repos[0]).toEqual({ github: 'group/backend', default_branch: 'main', description: 'svc' });
    expect(repos[1].github).toBe('group/mobile');
  });
});

describe('GitLabHost.resolveRepo', () => {
  it('returns default_branch for a project', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', mockFetchOnce({ default_branch: 'main' }));
    const host = new GitLabHost();
    expect(await host.resolveRepo('group/backend')).toEqual({ default_branch: 'main' });
  });

  it('returns null when the project 404s', async () => {
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const host = new GitLabHost();
    expect(await host.resolveRepo('group/missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify failure.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts -t listAccessibleRepos`
Expected: FAIL — throws `not implemented`.

- [ ] **Step 3: Implement the three methods** (replace stubs; add the `summarizeCi` import at the top of `client.ts`: `import { summarizeCi } from '../../system/pr-card-format.js';`):

```ts
async listAccessibleRepos(): Promise<Array<{ github: string; default_branch: string; description?: string }>> {
  const projects = await glRequestAll<{ path_with_namespace: string; default_branch: string | null; description: string | null }>({
    path: '/projects', query: { membership: true, order_by: 'last_activity_at', sort: 'desc' },
  });
  return projects
    .filter((p) => p.default_branch) // skip empty repos with no default branch
    .map((p) => ({
      github: p.path_with_namespace,
      default_branch: p.default_branch as string,
      ...(p.description ? { description: p.description } : {}),
    }));
}

async resolveRepo(repo: string): Promise<{ default_branch: string } | null> {
  try {
    const project = await glRequest<{ default_branch: string | null }>({ path: `/projects/${this.projectId(repo)}` });
    if (!project.default_branch) return null;
    return { default_branch: project.default_branch };
  } catch {
    return null;
  }
}

async getPRCardData(repo: string, prNumber: number): Promise<PrCardData> {
  const id = this.projectId(repo);
  const mr = await glRequest<{ iid: number; state: string; merged?: boolean; source_branch: string; sha: string; web_url: string }>({
    path: `/projects/${id}/merge_requests/${prNumber}`,
  });
  let ci = { state: 'none' as PrCardData['ci'], passed: 0, total: 0 };
  try {
    const checks = await this.listPRChecks(repo, prNumber);
    ci = summarizeCi(checks.entries);
  } catch (error) {
    logger.warn('gitlab', `Failed to fetch checks for MR !${prNumber} card`, error);
  }
  return {
    repo,
    prNumber,
    url: mr.web_url,
    headRef: mr.source_branch,
    state: mapMrState(mr.state, mr.merged),
    head_sha: mr.sha,
    ci: ci.state,
    ciPassed: ci.passed,
    ciTotal: ci.total,
  };
}
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-read.test.ts
git commit -m "feat(gitlab): repo listing, resolveRepo, and PR card data"
```

---

## Task 7: Wire `backends.ts` — resolver, env validation, singleton, boot probe

**Files:**
- Modify: `src/system/backends.ts`
- Create: `src/system/__tests__/backends-gitlab.test.ts`
- Modify: `src/index.ts` (call the capability probe at boot when `REPO_HOST=gitlab`)

**Interfaces:**
- Consumes: `GitLabHost` (Tasks 2–6).
- Produces: `getRepoHost()` returns the `GitLabHost` singleton when `REPO_HOST=gitlab`; `assertBackendConfig()` rejects gitlab when `GITLAB_BASE_URL`/`GITLAB_TOKEN`/`GITLAB_WEBHOOK_SECRET` are absent; `getGitLabHost()` for the boot probe.

- [ ] **Step 1: Write the failing test.** Create `src/system/__tests__/backends-gitlab.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveRepoHostKind, assertBackendConfig, getBackendMatrix } from '../backends.js';

const ORIG = { ...process.env };
afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

describe('backends resolver — gitlab', () => {
  it('resolves REPO_HOST=gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(resolveRepoHostKind()).toBe('gitlab');
  });

  it('accepts gitlab when all env is present', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).not.toThrow();
  });

  it('rejects gitlab with a missing env var, naming it', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    delete process.env.GITLAB_TOKEN;
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).toThrow(/GITLAB_TOKEN/);
  });

  it('reports the resolved matrix for gitlab', () => {
    process.env.REPO_HOST = 'gitlab';
    delete process.env.AGENT_RUNTIME;
    expect(getBackendMatrix()).toEqual({ repoHost: 'gitlab', runtime: 'claude' });
  });
});
```

- [ ] **Step 2: Run, verify failure.**

Run: `npx vitest run src/system/__tests__/backends-gitlab.test.ts`
Expected: FAIL — `assertBackendConfig` does not yet accept gitlab / validate env.

- [ ] **Step 3: Edit `src/system/backends.ts`.**

Add the import and singleton near the top:

```ts
import { GitLabHost } from '../connectors/gitlab/client.js';
```

Widen the supported list:

```ts
const SUPPORTED_REPO_HOSTS: RepoHostKind[] = ['github', 'gitlab'];
```

Add a GitLab env-validation helper and call it from `assertBackendConfig()` after the host-kind check passes:

```ts
const REQUIRED_GITLAB_ENV = ['GITLAB_BASE_URL', 'GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'] as const;

function assertGitLabEnv(): void {
  const missing = REQUIRED_GITLAB_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`REPO_HOST=gitlab requires ${missing.join(', ')} to be set.`);
  }
}
```

In `assertBackendConfig()`, after the existing repo-host supported check, add:

```ts
if (host === 'gitlab') assertGitLabEnv();
```

Add the singleton + resolver branch:

```ts
let gitlabSingleton: GitLabHost | null = null;
export function getGitLabHost(): GitLabHost {
  if (!gitlabSingleton) gitlabSingleton = new GitLabHost();
  return gitlabSingleton;
}
```

In `getRepoHost()`, add the branch before `default`:

```ts
case 'gitlab':
  return getGitLabHost();
```

- [ ] **Step 4: Run the resolver tests + full suite.**

Run: `npm run typecheck && npx vitest run src/system/__tests__/backends-gitlab.test.ts && npm test`
Expected: PASS (baseline + new). The default-config suite is unchanged.

- [ ] **Step 5: Probe capabilities at boot.** In `src/index.ts`, after `assertBackendConfig()` runs and before serving, add (guarded so GitHub boots unchanged):

```ts
if (resolveRepoHostKind() === 'gitlab') {
  await getGitLabHost().probeCapabilities();
}
```

Import `resolveRepoHostKind` and `getGitLabHost` from `./system/backends.js` if not already imported. Place it near the existing backend-matrix log line so the resolved capabilities are logged together at boot.

- [ ] **Step 6: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/system/backends.ts src/system/__tests__/backends-gitlab.test.ts src/index.ts
git commit -m "feat(backends): resolve REPO_HOST=gitlab with env validation + boot capability probe"
```

---

## Self-Review

- **Spec coverage (read-side subset):** `getPRStatus`/`getPRDetails`/`listPRs`/`getPRComments` (Task 4), CI `listPRChecks`/`getCheckRunById`/`getWorkflowRunById`/log-tail (Task 5), `listAccessibleRepos`/`resolveRepo`/`getPRCardData` (Task 6), `detailed_merge_status` mapping (Task 1), capability probe / R2 (Task 3), config + env validation (Task 7). Write/review methods, webhooks, clone/askpass, docs are Plans 2–4 (out of scope here, tracked in the design doc).
- **Placeholder scan:** no TBD/TODO; the `throw NOT_IMPL(...)` stubs are compiling scaffolding replaced within this plan (read methods) or Plan 2 (write methods), not plan placeholders. Every code step shows complete code.
- **Type consistency:** methods return the exact `ports/repo-host-types.ts` shapes; `PRCheckEntry.source` uses `'check_run'` (valid union member); `listAccessibleRepos` uses the `github` field name per the interface; `getBackendMatrix` matches the Phase 0 shape.
- **Isolation:** all GitLab HTTP goes through `http.ts`; the acceptance grep (`api/v4` outside `connectors/gitlab`) stays empty.
