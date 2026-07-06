# Phase 1 · GitLab Host — Plan 2: Write/Action Methods, Reviews (D2) & Security

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-06-phase-1-gitlab-host-design.md` — Phase 1 design (esp. decision 2: reviews synthesized from approvals + unresolved discussions; D2).
> - `docs/architecture/backends.md` — the seam.
> - `src/ports/repo-host.ts`, `src/ports/repo-host-types.ts`, `src/ports/capabilities.ts` — interface + canonical types.
> - `src/connectors/gitlab/client.ts` — the Plan 1 read-side + the `throw NOT_IMPL(...)` stubs you now replace; `src/connectors/gitlab/http.ts` (`glRequest`/`glRequestAll`); `src/connectors/gitlab/__tests__/client-read.test.ts` (test conventions; robust `afterEach`).
> - `src/connectors/github/client.ts` — the reference GitHub implementations of every method below.

**Goal:** Replace the remaining `GitLabHost` `NOT_IMPL` stubs — MR mutations, merge, reviews (approvals + discussions, per D2), and Ultimate-only security — so `REPO_HOST=gitlab` supports the full edit → CR → review → merge flow, with the GitHub path unchanged.

**Architecture:** Same anti-corruption pattern as Plan 1: map GitLab REST v4 into the canonical `ports/repo-host-types.ts` shapes via `glRequest`/`glRequestAll`. Reviews are *synthesized* — GitLab has no `changes_requested` state, so `getPRReviews` merges the approvals API (→ `approved`) with unresolved reviewer discussions (→ `changes_requested`, D2). Security maps GitLab's Ultimate vulnerabilities API and stays capability-gated.

**Tech Stack:** Node ≥20 (ESM, `.js` specifiers), TypeScript, Vitest ^4, global `fetch` via the Plan 1 `http.ts` helper. No new dependency.

## Global Constraints

- **Additive / zero behavior change (P1).** No change to the GitHub or Claude path. Full suite (`npm test`) passes unmodified after every task; existing tests not edited. Default config stays `REPO_HOST=github`.
- **Vendor isolation.** No GitLab HTTP outside `src/connectors/gitlab/`; every call goes through `glRequest`/`glRequestAll`.
- **Canonical schema.** Methods return the exact `ports/repo-host-types.ts` shapes. `repo` is `group/project`, URL-encoded via the existing private `projectId()`; MR number is the `iid`.
- **Graceful degradation (P3).** Where GitLab can't match a GitHub capability, degrade with a clear log/return, never a raw throw on a normal path. `requestReReview` is a logged no-op (`reReviewRequest=false`). Security is gated on `capabilities().securityAlerts`.
- **Logging.** Never `console.*`; use `logger` from `src/system/logger.ts` (`logger.system(...)`, `logger.warn('gitlab', ...)`, `logger.error('gitlab', ...)`).
- **Test reality.** Unit tests mock `fetch`, so they validate *mapping logic against the response shapes assumed here*, not the live API. Real-shape correctness for positioned diff-notes (Task 3) and the Ultimate vulnerabilities API (Task 4) is a **manual E2E gate** (Plan 4), and each such method carries an `// E2E-VERIFY:` comment naming the endpoint + assumed fields.
- **Commits.** Atomic, one logical change per task; commit at task end (authorized; do not push).

## File Structure

Modified files:
- `src/connectors/gitlab/client.ts` — replace the write/review/security stubs with real bodies; add small private helpers (`mrAuthor`, `findDiscussionIdForNote`, `mapVulnerability`).
- `src/connectors/gitlab/__tests__/client-write.test.ts` — new test file for the write/review/security methods (keeps `client-read.test.ts` focused on reads).

No `capabilities.ts` change: `GITLAB_CAPABILITIES_DEFAULT` already has `reviewStates:false, reReviewRequest:false`; the `/license` probe already flips `securityAlerts` on Ultimate (Plan 1). This plan makes that flag honest by implementing the security methods.

## Task order

T1 (MR mutations + merge) → T2 (reviews read: getPRReviews synthesis + getReviewThreads) → T3 (reviews write: resolveReviewThread, replyToReviewComment, addReviewComment, requestReReview) → T4 (security: list/get). Each is independently unit-testable with mocked `fetch`.

---

## Task 1: MR mutations + merge

**Files:**
- Modify: `src/connectors/gitlab/client.ts` — replace stubs: `createPullRequest`, `updatePR`, `closePullRequest`, `addPRComment`, `mergePullRequest`, `pushBranch`.
- Create: `src/connectors/gitlab/__tests__/client-write.test.ts`

**Interfaces:**
- Consumes: `glRequest` (`./http.js`), `mapMrState` (unused here), the private `projectId()`.
- Produces: real bodies returning canonical shapes (`CreatePRResult`, `{ success, message }`).

- [ ] **Step 1: Write the failing tests.** Create `src/connectors/gitlab/__tests__/client-write.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabHost } from '../client.js';

const ENV = { ...process.env };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ENV };
});

function setEnv() {
  process.env.GITLAB_BASE_URL = 'https://gl.example';
  process.env.GITLAB_TOKEN = 't';
}

describe('GitLabHost.createPullRequest', () => {
  it('POSTs an MR and returns iid + web_url', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ iid: 12, web_url: 'https://gl.example/g/p/-/merge_requests/12' }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const res = await host.createPullRequest('g/p', 'feat/x', 'main', 'Title', 'Body');
    expect(res).toEqual({ pr_number: 12, pr_url: 'https://gl.example/g/p/-/merge_requests/12' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/projects/g%2Fp/merge_requests');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ source_branch: 'feat/x', target_branch: 'main', title: 'Title', description: 'Body' });
  });
});

describe('GitLabHost.mergePullRequest', () => {
  it('squashes by default and returns success', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'merged' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const res = await host.mergePullRequest('g/p', 12);
    expect(res.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12/merge');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ squash: true });
  });

  it('returns success:false with the error message on failure', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Method Not Allowed', { status: 405 })));
    const host = new GitLabHost();
    const res = await host.mergePullRequest('g/p', 12);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/405|Method Not Allowed/);
  });
});

describe('GitLabHost.closePullRequest / updatePR / addPRComment', () => {
  it('closePullRequest PUTs state_event=close', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().closePullRequest('g/p', 12);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ state_event: 'close' });
  });

  it('updatePR maps title/body/base to title/description/target_branch', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().updatePR('g/p', 12, { title: 'T', body: 'B', base: 'develop' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ title: 'T', description: 'B', target_branch: 'develop' });
  });

  it('addPRComment POSTs a note', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().addPRComment('g/p', 12, 'hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12/notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'hello' });
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts`
Expected: FAIL — methods throw `not implemented until Plan 2`.

- [ ] **Step 3: Replace the six stubs in `client.ts`.**

```ts
async createPullRequest(repo: string, head: string, base: string, title: string, body: string): Promise<CreatePRResult> {
  const mr = await glRequest<{ iid: number; web_url: string }>({
    method: 'POST',
    path: `/projects/${this.projectId(repo)}/merge_requests`,
    body: { source_branch: head, target_branch: base, title, description: body },
  });
  logger.system(`GitLab: created MR !${mr.iid} for ${repo} (${head} -> ${base})`);
  return { pr_number: mr.iid, pr_url: mr.web_url };
}

async updatePR(repo: string, prNumber: number, fields: { title?: string; body?: string; base?: string }): Promise<void> {
  const patch: Record<string, string> = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.body !== undefined) patch.description = fields.body;
  if (fields.base !== undefined) patch.target_branch = fields.base;
  await glRequest({ method: 'PUT', path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}`, body: patch });
  logger.system(`GitLab: updated MR !${prNumber}`);
}

async closePullRequest(repo: string, prNumber: number): Promise<void> {
  await glRequest({
    method: 'PUT',
    path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}`,
    body: { state_event: 'close' },
  });
  logger.system(`GitLab: closed MR !${prNumber}`);
}

async addPRComment(repo: string, prNumber: number, comment: string): Promise<void> {
  await glRequest({
    method: 'POST',
    path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/notes`,
    body: { body: comment },
  });
  logger.system(`GitLab: added note to MR !${prNumber}`);
}

async mergePullRequest(repo: string, prNumber: number, mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<{ success: boolean; message: string }> {
  // GitLab's merge endpoint has no 'rebase' merge; it exposes a boolean `squash`.
  // Map for parity: 'squash' (Archie's default) → squash:true; 'merge'/'rebase' → squash:false.
  const squash = mergeMethod === 'squash';
  try {
    await glRequest({
      method: 'PUT',
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/merge`,
      body: { squash },
    });
    logger.system(`GitLab: merged MR !${prNumber} (squash=${squash})`);
    return { success: true, message: `MR !${prNumber} merged successfully` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('gitlab', `Failed to merge MR !${prNumber}: ${message}`);
    return { success: false, message };
  }
}

async pushBranch(repo: string, branch: string, worktreePath: string): Promise<{ success: boolean; message: string }> {
  // Parity with the GitHub host: the actual push happens via git CLI in the
  // worktree (host-agnostic); this method is a no-op acknowledgement.
  logger.system(`GitLab: pushBranch called for ${repo}:${branch} from ${worktreePath}`);
  return { success: true, message: `Would push ${branch} to ${repo}` };
}
```

- [ ] **Step 4: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts && npm test`
Expected: PASS (baseline + new).

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-write.test.ts
git commit -m "feat(gitlab): MR mutations + merge (create/update/close/comment/merge/push)"
```

---

## Task 2: Reviews (read) — `getPRReviews` synthesis (D2) + `getReviewThreads`

**Files:**
- Modify: `src/connectors/gitlab/client.ts` — replace `getPRReviews`, `getReviewThreads` stubs; add private `mrAuthor(repo, iid)`.
- Modify: `src/connectors/gitlab/__tests__/client-write.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll`.
- Produces: `getPRReviews` → `PRReview[]` (approvals → `approved`; unresolved reviewer discussions → one synthesized `changes_requested`); `getReviewThreads` → `ReviewThread[]` from discussions.

> D2 (design decision 2): GitLab has no `changes_requested` review state. Synthesize it — any resolvable, unresolved discussion started by someone other than the MR author counts as changes-requested. `capabilities().reviewStates` is `false`, so callers that care know these are synthesized.

- [ ] **Step 1: Write the failing tests.** Append to `client-write.test.ts`:

```ts
describe('GitLabHost.getPRReviews (D2 synthesis)', () => {
  it('maps approvals to approved and unresolved reviewer discussions to changes_requested', async () => {
    setEnv();
    const fetchMock = vi.fn()
      // MR (for author)
      .mockResolvedValueOnce(new Response(JSON.stringify({ author: { username: 'author1' } }), { status: 200 }))
      // approvals
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved_by: [{ user: { username: 'rev1' } }] }), { status: 200 }))
      // discussions (paginated; one unresolved reviewer thread, one authored by the MR author, one resolved)
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 'd1', individual_note: false, notes: [{ author: { username: 'rev2' }, body: 'please fix', resolvable: true, resolved: false, created_at: '2026-01-01T00:00:00Z' }] },
        { id: 'd2', individual_note: false, notes: [{ author: { username: 'author1' }, body: 'self note', resolvable: true, resolved: false, created_at: '2026-01-01T00:01:00Z' }] },
        { id: 'd3', individual_note: false, notes: [{ author: { username: 'rev2' }, body: 'ok now', resolvable: true, resolved: true, created_at: '2026-01-01T00:02:00Z' }] },
      ]), { status: 200, headers: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const reviews = await new GitLabHost().getPRReviews('g/p', 12);
    const approved = reviews.filter((r) => r.state === 'approved');
    const changes = reviews.filter((r) => r.state === 'changes_requested');
    expect(approved.map((r) => r.user)).toEqual(['rev1']);
    // Only rev2's unresolved, non-author, resolvable discussion counts.
    expect(changes).toHaveLength(1);
    expect(changes[0].user).toBe('rev2');
  });
});

describe('GitLabHost.getReviewThreads', () => {
  it('maps resolvable discussions to ReviewThread with comments', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        id: 'disc1', individual_note: false,
        notes: [{
          id: 101, author: { username: 'rev2' }, body: 'line comment', resolvable: true, resolved: false,
          created_at: '2026-01-01T00:00:00Z',
          position: { new_path: 'src/a.ts', new_line: 42 },
        }],
      },
      { id: 'plain', individual_note: true, notes: [{ id: 200, author: { username: 'x' }, body: 'not a thread', resolvable: false, resolved: false, created_at: '2026-01-01T00:00:00Z' }] },
    ]), { status: 200 })));

    const threads = await new GitLabHost().getReviewThreads('g/p', 12);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadId: 'disc1', isResolved: false, path: 'src/a.ts', line: 42 });
    expect(threads[0].comments[0]).toMatchObject({ commentId: 101, author: 'rev2', body: 'line comment' });
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts -t "getPRReviews\|getReviewThreads"`
Expected: FAIL — stubs throw.

- [ ] **Step 3: Implement in `client.ts`** (replace the two stubs; add the private helper):

```ts
/** MR author username, used to exclude self-authored discussions from D2 synthesis. */
private async mrAuthor(repo: string, prNumber: number): Promise<string | null> {
  try {
    const mr = await glRequest<{ author?: { username?: string } }>({
      path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}`,
    });
    return mr.author?.username ?? null;
  } catch {
    return null;
  }
}

async getPRReviews(repo: string, prNumber: number): Promise<PRReview[]> {
  const id = this.projectId(repo);
  const author = await this.mrAuthor(repo, prNumber);
  const reviews: PRReview[] = [];

  // Approvals → approved reviews (one per approver).
  const approvals = await glRequest<{ approved_by?: Array<{ user?: { username?: string } }> }>({
    path: `/projects/${id}/merge_requests/${prNumber}/approvals`,
  }).catch(() => ({ approved_by: [] as Array<{ user?: { username?: string } }> }));
  for (const a of approvals.approved_by ?? []) {
    reviews.push({ id: `approval:${a.user?.username ?? 'unknown'}`, user: a.user?.username ?? 'unknown', state: 'approved', body: '', submittedAt: '' });
  }

  // D2: unresolved, resolvable discussions started by a non-author reviewer →
  // one synthesized changes_requested review per such reviewer.
  const discussions = await glRequestAll<{
    id: string; individual_note?: boolean;
    notes?: Array<{ author?: { username?: string }; body?: string; resolvable?: boolean; resolved?: boolean; created_at?: string }>;
  }>({ path: `/projects/${id}/merge_requests/${prNumber}/discussions` });

  const changeRequesters = new Map<string, { body: string; at: string }>();
  for (const d of discussions) {
    if (d.individual_note) continue;
    const first = d.notes?.[0];
    if (!first || !first.resolvable || first.resolved) continue;
    const user = first.author?.username;
    if (!user || user === author) continue;
    if (!changeRequesters.has(user)) {
      changeRequesters.set(user, { body: first.body ?? '', at: first.created_at ?? '' });
    }
  }
  for (const [user, info] of changeRequesters) {
    reviews.push({ id: `discussion:${user}`, user, state: 'changes_requested', body: info.body, submittedAt: info.at });
  }

  logger.system(`GitLab: MR !${prNumber} reviews: ${reviews.filter((r) => r.state === 'approved').length} approved, ${changeRequesters.size} changes_requested (synthesized)`);
  return reviews;
}

async getReviewThreads(repo: string, prNumber: number): Promise<ReviewThread[]> {
  const discussions = await glRequestAll<{
    id: string; individual_note?: boolean;
    notes?: Array<{
      id: number; author?: { username?: string }; body?: string; resolvable?: boolean; resolved?: boolean;
      created_at?: string; position?: { new_path?: string; new_line?: number | null };
    }>;
  }>({ path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions` });

  const threads: ReviewThread[] = [];
  for (const d of discussions) {
    // Only resolvable (review) discussions become threads; individual_note=true are plain comments.
    if (d.individual_note) continue;
    const notes = d.notes ?? [];
    const first = notes[0];
    if (!first?.resolvable) continue;
    const pos = first.position;
    threads.push({
      threadId: d.id,
      isResolved: notes.every((n) => n.resolved !== false ? n.resolved === true : false) ? notes.some((n) => n.resolved) : first.resolved === true,
      isOutdated: false, // GitLab exposes outdated only via position drift; not modeled here.
      path: pos?.new_path ?? '',
      line: pos?.new_line ?? null,
      comments: notes.map((n) => ({
        commentId: n.id,
        author: n.author?.username ?? 'unknown',
        body: n.body ?? '',
        createdAt: n.created_at ?? '',
        url: `${this.cloneUrl(repo).replace(/\.git$/, '')}/-/merge_requests/${prNumber}#note_${n.id}`,
      })),
    });
  }
  return threads;
}
```

> Simplify the `isResolved` expression during implementation to: `isResolved: (first.resolved === true)` — a discussion's resolution state tracks its first note in GitLab. The verbose ternary above is illustrative; use `isResolved: first.resolved === true`.

- [ ] **Step 4: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-write.test.ts
git commit -m "feat(gitlab): synthesize reviews from approvals + unresolved discussions (D2)"
```

---

## Task 3: Reviews (write) — resolve, reply, add-review-comment, request-re-review

**Files:**
- Modify: `src/connectors/gitlab/client.ts` — replace `resolveReviewThread`, `replyToReviewComment`, `addReviewComment`, `requestReReview` stubs; add private `findDiscussionIdForNote`.
- Modify: `src/connectors/gitlab/__tests__/client-write.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll`.
- Produces: real bodies. `resolveReviewThread(repo, iid, threadId)` where `threadId` is the discussion id from `getReviewThreads`. `replyToReviewComment(repo, iid, commentId, body)` looks up the discussion containing that note id. `addReviewComment` posts a positioned diff discussion. `requestReReview` is a logged no-op.

- [ ] **Step 1: Write the failing tests.** Append to `client-write.test.ts`:

```ts
describe('GitLabHost.resolveReviewThread', () => {
  it('PUTs resolved=true on the discussion', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().resolveReviewThread('g/p', 12, 'disc1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/merge_requests/12/discussions/disc1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ resolved: true });
  });
});

describe('GitLabHost.replyToReviewComment', () => {
  it('finds the discussion holding the note id and POSTs a reply note', async () => {
    setEnv();
    const fetchMock = vi.fn()
      // discussions lookup
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 'discA', notes: [{ id: 500 }, { id: 501 }] },
        { id: 'discB', notes: [{ id: 999 }] },
      ]), { status: 200 }))
      // reply POST
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 502 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await new GitLabHost().replyToReviewComment('g/p', 12, 501, 'thanks');
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/merge_requests/12/discussions/discA/notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ body: 'thanks' });
  });

  it('throws a clear error when no discussion holds the note id', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'discB', notes: [{ id: 999 }] }]), { status: 200 })));
    await expect(new GitLabHost().replyToReviewComment('g/p', 12, 501, 'x')).rejects.toThrow(/discussion/i);
  });
});

describe('GitLabHost.requestReReview', () => {
  it('is a logged no-op (reReviewRequest capability is false)', async () => {
    setEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().requestReReview('g/p', 12);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts -t "resolveReviewThread\|replyToReviewComment\|requestReReview"`
Expected: FAIL — stubs throw (except requestReReview which throws too).

- [ ] **Step 3: Implement in `client.ts`** (replace the four stubs; add the helper):

```ts
async resolveReviewThread(repo: string, prNumber: number, threadId: string): Promise<void> {
  await glRequest({
    method: 'PUT',
    path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions/${threadId}`,
    query: { resolved: true },
  });
  logger.system(`GitLab: resolved discussion ${threadId} on MR !${prNumber}`);
}

/** Find the discussion id that contains a given note id (GitLab replies target a discussion, not a note). */
private async findDiscussionIdForNote(repo: string, prNumber: number, noteId: number): Promise<string | null> {
  const discussions = await glRequestAll<{ id: string; notes?: Array<{ id: number }> }>({
    path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions`,
  });
  for (const d of discussions) {
    if ((d.notes ?? []).some((n) => n.id === noteId)) return d.id;
  }
  return null;
}

async replyToReviewComment(repo: string, prNumber: number, commentId: number, comment: string): Promise<void> {
  const discussionId = await this.findDiscussionIdForNote(repo, prNumber, commentId);
  if (!discussionId) {
    throw new Error(`GitLab: no discussion found containing note ${commentId} on MR !${prNumber}`);
  }
  await glRequest({
    method: 'POST',
    path: `/projects/${this.projectId(repo)}/merge_requests/${prNumber}/discussions/${discussionId}/notes`,
    body: { body: comment },
  });
  logger.system(`GitLab: replied in discussion ${discussionId} on MR !${prNumber}`);
}

async addReviewComment(repo: string, prNumber: number, path: string, line: number, comment: string): Promise<void> {
  // E2E-VERIFY: positioned diff note. Endpoint: POST /merge_requests/:iid/discussions
  // with position { position_type:'text', new_path, new_line, base_sha, head_sha, start_sha }.
  // The three shas come from the MR's diff_refs. Verify the field names + a real
  // line maps correctly against the live instance (Plan 4 E2E).
  const id = this.projectId(repo);
  const mr = await glRequest<{ diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } }>({
    path: `/projects/${id}/merge_requests/${prNumber}`,
  });
  const refs = mr.diff_refs;
  if (!refs?.base_sha || !refs?.head_sha || !refs?.start_sha) {
    throw new Error(`GitLab: MR !${prNumber} has no diff_refs; cannot post a positioned review comment`);
  }
  await glRequest({
    method: 'POST',
    path: `/projects/${id}/merge_requests/${prNumber}/discussions`,
    body: {
      body: comment,
      position: {
        position_type: 'text',
        new_path: path,
        new_line: line,
        base_sha: refs.base_sha,
        head_sha: refs.head_sha,
        start_sha: refs.start_sha,
      },
    },
  });
  logger.system(`GitLab: added review comment to ${path}:${line} on MR !${prNumber}`);
}

async requestReReview(repo: string, prNumber: number): Promise<void> {
  // GitLab has no re-review request primitive; capability reReviewRequest=false.
  // Degrade gracefully (P3): log and no-op rather than throwing on a normal path.
  logger.system(`GitLab: requestReReview is a no-op on this host (MR !${prNumber}); reReviewRequest capability is false`);
}
```

- [ ] **Step 4: Add the `addReviewComment` positioned-note test.** Append to `client-write.test.ts`:

```ts
describe('GitLabHost.addReviewComment', () => {
  it('POSTs a positioned discussion using the MR diff_refs', async () => {
    setEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await new GitLabHost().addReviewComment('g/p', 12, 'src/a.ts', 42, 'nit');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.position).toMatchObject({ position_type: 'text', new_path: 'src/a.ts', new_line: 42, base_sha: 'b', head_sha: 'h', start_sha: 's' });
  });
});
```

- [ ] **Step 5: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-write.test.ts
git commit -m "feat(gitlab): review-write methods (resolve, reply, positioned comment, re-review no-op)"
```

---

## Task 4: Security — `listCodeScanningAlerts` / `getCodeScanningAlert` (Ultimate, capability-gated)

**Files:**
- Modify: `src/connectors/gitlab/client.ts` — replace the two security stubs; add private `mapVulnerability`.
- Modify: `src/connectors/gitlab/__tests__/client-write.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll`.
- Produces: `listCodeScanningAlerts` / `getCodeScanningAlert` returning canonical `CodeScanningAlert[]` / `CodeScanningAlert` mapped from GitLab's Ultimate vulnerabilities API. These are only reached when `capabilities().securityAlerts` is true (the tool layer gates on it; the `/license` probe only sets it on Ultimate).

> This makes the Plan 1 `securityAlerts` probe honest: on a non-Ultimate instance the capability is false and the tools short-circuit before calling these (existing gate in `agents/tools.ts`). On Ultimate they map real findings.

- [ ] **Step 1: Write the failing tests.** Append to `client-write.test.ts`:

```ts
describe('GitLabHost.listCodeScanningAlerts', () => {
  it('maps GitLab vulnerabilities into canonical CodeScanningAlert[]', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        id: 7, state: 'detected', report_type: 'sast', severity: 'high',
        name: 'SQL Injection', description: 'desc', location: { file: 'src/db.ts', start_line: 10 },
        web_url: 'https://gl.example/g/p/-/security/vulnerabilities/7',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
      },
    ]), { status: 200 })));

    const alerts = await new GitLabHost().listCodeScanningAlerts('g/p', { state: 'open' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      number: 7, tool: 'sast', securitySeverity: 'high', ruleName: 'SQL Injection',
      url: 'https://gl.example/g/p/-/security/vulnerabilities/7',
    });
    expect(alerts[0].mostRecentInstance).toMatchObject({ path: 'src/db.ts', startLine: 10 });
  });
});

describe('GitLabHost.getCodeScanningAlert', () => {
  it('maps one vulnerability by id', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 7, state: 'detected', report_type: 'sast', severity: 'critical', name: 'RCE',
      description: 'd', location: { file: 'a.ts', start_line: 3 }, web_url: 'u',
    }), { status: 200 })));
    const alert = await new GitLabHost().getCodeScanningAlert('g/p', 7);
    expect(alert).toMatchObject({ number: 7, tool: 'sast', securitySeverity: 'critical', ruleName: 'RCE' });
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts -t "CodeScanningAlert"`
Expected: FAIL — stubs throw.

- [ ] **Step 3: Implement in `client.ts`** (replace the two stubs; add the mapper):

```ts
/**
 * Map a GitLab vulnerability (Ultimate) into the canonical CodeScanningAlert.
 * E2E-VERIFY: field names on GET /projects/:id/vulnerabilities against a real
 * Ultimate instance (report_type/severity/location shape) — Plan 4 E2E.
 */
private mapVulnerability(v: any): CodeScanningAlert {
  const loc = v.location ?? {};
  return {
    number: v.id,
    state: v.state ?? 'detected',
    tool: v.report_type ?? 'unknown',
    ruleId: v.identifier ?? null,
    ruleName: v.name ?? null,
    ruleDescription: v.description ?? null,
    severity: v.severity ?? null,
    securitySeverity: v.severity ?? null,
    url: v.web_url ?? null,
    createdAt: v.created_at ?? null,
    updatedAt: v.updated_at ?? null,
    dismissedReason: v.dismissal_reason ?? null,
    dismissedComment: null,
    mostRecentInstance: {
      ref: null,
      state: v.state ?? null,
      path: loc.file ?? null,
      startLine: loc.start_line ?? null,
      endLine: loc.end_line ?? null,
      message: v.description ?? null,
    },
  };
}

async listCodeScanningAlerts(repo: string, filters: CodeScanningAlertFilters = {}): Promise<CodeScanningAlert[]> {
  // GitLab vulnerability state vocabulary: detected|confirmed|dismissed|resolved.
  // Map the canonical open|dismissed|fixed loosely; default to the detected set.
  const stateMap: Record<string, string> = { open: 'detected', dismissed: 'dismissed', fixed: 'resolved' };
  const vulns = await glRequestAll<any>({
    path: `/projects/${this.projectId(repo)}/vulnerabilities`,
    query: { state: filters.state ? stateMap[filters.state] : undefined },
  });
  const alerts = vulns.map((v) => this.mapVulnerability(v));
  logger.system(`GitLab: vulnerabilities for ${repo}: ${alerts.length}`);
  return alerts;
}

async getCodeScanningAlert(repo: string, alertNumber: number): Promise<CodeScanningAlert> {
  const v = await glRequest<any>({ path: `/vulnerabilities/${alertNumber}` });
  return this.mapVulnerability(v);
}
```

> Note the `getCodeScanningAlert` path is the instance-level `/vulnerabilities/:id` (GitLab's single-vulnerability endpoint is not project-scoped). Confirm in E2E.

- [ ] **Step 4: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-write.test.ts
git commit -m "feat(gitlab): map Ultimate vulnerabilities to code-scanning alerts (capability-gated)"
```

---

## Self-Review

- **Spec coverage:** MR mutations + merge (T1), reviews read/D2 synthesis (T2), reviews write incl. positioned notes + re-review no-op (T3), security Ultimate-gated (T4). After Plan 2, `GitLabHost` has **no remaining `NOT_IMPL` stubs**. The final-review carry-forwards for Plan 2 (reviews honest, security honest) are addressed.
- **Placeholder scan:** no TBD/TODO. `E2E-VERIFY:` comments mark the two API-shape-uncertain methods (positioned notes, vulnerabilities) — these are deliberate, since mocked-fetch unit tests can't validate real GitLab response shapes; Plan 4's E2E is the gate.
- **Type consistency:** all methods return the exact `ports/repo-host-types.ts` shapes; `PRReview.state` uses only `approved`/`changes_requested`; `getReviewThreads` returns `ReviewThread`; security returns `CodeScanningAlert`.
- **Graceful degradation:** `requestReReview` no-ops with a log (not a throw); `replyToReviewComment` throws only when the note genuinely isn't found (a real error, not a capability gap); security is reached only when the capability gate passes.
- **Isolation:** every call via `glRequest`/`glRequestAll`; no direct `fetch`.
- **Known limitation to flag at execution:** `getReviewThreads` `isResolved` should be implemented as `first.resolved === true` (the illustrative ternary in Task 2 Step 3 is replaced per the note).
