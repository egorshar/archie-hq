# run_manual_job — core RepoHost seam (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-07-release-flow-design.md` — the "Core addition — run_manual_job seam" section.
> - `src/ports/repo-host-types.ts`, `src/ports/repo-host.ts`, `src/ports/capabilities.ts` — mirror how `WorkflowDispatchResult` / `dispatchWorkflow` / `workflowDispatch` were added (the `dispatch_workflow` seam is the exact template).
> - `src/connectors/gitlab/client.ts` (`listPRChecks` around line 217 shows the MR→head_pipeline→jobs fetch; `glRequest`/`glRequestAll`/`projectId`).
> - `src/agents/tools.ts` (`createDispatchWorkflowTool` + `createRepoToolsMcpServer`) and `src/agents/spawn.ts` (`REPO_TOOLS_REQUIRING_EDIT_MODE`) — the tool + edit-mode-gate template.

**Goal:** Add a `run_manual_job` capability to the repo-host seam — `RepoHost.runManualJob(repo, prNumber, jobName)` + a capability-gated, edit-mode-gated `run_manual_job` MCP tool — so an agent can play a manual CI job (e.g. a "Ready to prod" release-deploy job) in a merge request's pipeline, in-process (no token in the agent). Prerequisite for the release flow's deploy.

**Architecture:** Exact `dispatch_workflow` pattern: canonical port method + result type + capability flag, GitLab implements (3 GitLab REST calls: MR → head pipeline → jobs → play), GitHub is a capability-off stub (no clean 1:1). Edit-mode-gated (a prod deploy) via `REPO_TOOLS_REQUIRING_EDIT_MODE`.

**Tech Stack:** Node ≥20 ESM (`.js` specifiers), TypeScript, Vitest. GitLab via `glRequest`/`glRequestAll`.

## Global Constraints
- **Additive / zero behavior change.** Full `npm test` passes; existing tests unedited except the two allowlist/gate tests noted (they are designed to grow). GitHub default path unaffected.
- **Canonical naming:** `runManualJob`, `ManualJobResult`, tool `run_manual_job`, capability `manualJobs`. No GitLab-isms (`play`, `pipeline`) in the port layer.
- **No secret in agents:** the tool calls `getRepoHost().runManualJob()` in-process; the agent passes only args.
- **Capability-gated** (`manualJobs`, GitLab `true` / GitHub `false`) **and edit-mode-gated** (added to `REPO_TOOLS_REQUIRING_EDIT_MODE` — it's a prod deploy, same as `dispatch_workflow`).
- **Vendor isolation:** GitLab REST only in `src/connectors/gitlab/`. **Logging:** `logger` only. **Commits:** atomic, one per task; commit at task end (do not push).

## File Structure
Modified: `src/ports/repo-host-types.ts` (+`ManualJobResult`), `src/ports/repo-host.ts` (+`runManualJob`), `src/ports/capabilities.ts` (+`manualJobs`), `src/connectors/github/client.ts` (stub), `src/connectors/gitlab/client.ts` (impl), `src/agents/tools.ts` (tool + register), `src/agents/spawn.ts` (edit-mode gate). Tests: `src/ports/__tests__/capabilities.test.ts`, `src/connectors/gitlab/__tests__/client-write.test.ts`, `src/agents/__tests__/pr-tools.test.ts`, `src/agents/__tests__/tool-contract.test.ts`.

## Task order
T1 (types + port + capability + compiling stubs) → T2 (GitLab impl) → T3 (tool + edit-mode gate).

---

## Task 1: Port method, result type, capability flag, compiling stubs

**Files:** Modify `src/ports/repo-host-types.ts`, `src/ports/repo-host.ts`, `src/ports/capabilities.ts`, `src/connectors/github/client.ts`, `src/connectors/gitlab/client.ts`, `src/ports/__tests__/capabilities.test.ts`

**Interfaces:**
- Produces: `ManualJobResult { id: number|string|null; url: string|null; status: string|null }`; `RepoHost.runManualJob(repo: string, prNumber: number, jobName: string): Promise<ManualJobResult>`; `RepoHostCapabilities.manualJobs: boolean`. Consumed by T2 (GitLab impl) + T3 (tool).

- [ ] **Step 1: Failing capability assertions.** In `src/ports/__tests__/capabilities.test.ts`, extend the GitHub + GitLab-default blocks:
```ts
expect(GITHUB_CAPABILITIES.manualJobs).toBe(false);
it('gitlab defaults advertise manualJobs', () => {
  expect(GITLAB_CAPABILITIES_DEFAULT.manualJobs).toBe(true);
});
```

- [ ] **Step 2: Run, verify RED.** `npx vitest run src/ports/__tests__/capabilities.test.ts` → FAIL (`manualJobs` missing).

- [ ] **Step 3: Result type** in `src/ports/repo-host-types.ts` (near `WorkflowDispatchResult`):
```ts
/**
 * Result of playing a manual/gated CI job (canonical). GitLab returns the played
 * job (id + web_url + status). GitHub has no 1:1 (capability-off), so fields may be null.
 */
export interface ManualJobResult {
  id: number | string | null;
  url: string | null;
  status: string | null;
}
```

- [ ] **Step 4: Port method** in `src/ports/repo-host.ts`. Add `ManualJobResult` to the `./repo-host-types.js` type import, then near `dispatchWorkflow`:
```ts
  /**
   * Play a manual/gated CI job by name in a change request's pipeline (e.g. a
   * "Ready to prod" release-deploy job). GitLab: resolve the MR's head pipeline,
   * find the job named `jobName`, and play it. Gated by capabilities().manualJobs.
   * GitHub has no clean equivalent (nearest is approving a pending deployment) —
   * capability-off there.
   */
  runManualJob(repo: string, prNumber: number, jobName: string): Promise<ManualJobResult>;
```

- [ ] **Step 5: Capability flag** in `src/ports/capabilities.ts`. In `RepoHostCapabilities`:
```ts
  /** can play a manual/gated CI job by name in a change request's pipeline (GitLab manual jobs). */
  manualJobs: boolean;
```
Add `manualJobs: false,` to `GITHUB_CAPABILITIES` and `manualJobs: true,` to `GITLAB_CAPABILITIES_DEFAULT`.

- [ ] **Step 6: GitHub stub** in `src/connectors/github/client.ts` (add `ManualJobResult` to its `repo-host-types.js` type import):
```ts
async runManualJob(_repo: string, _prNumber: number, _jobName: string): Promise<ManualJobResult> {
  // GitHub has no play-a-manual-job-by-name equivalent (manualJobs capability is false);
  // the tool layer gates on the capability, so this is unreachable in normal flow.
  throw new Error('runManualJob is not available on the GitHub repo host');
}
```

- [ ] **Step 7: GitLab stub** in `src/connectors/gitlab/client.ts` (add `ManualJobResult` to its `repo-host-types.js` type import; real impl in T2):
```ts
async runManualJob(_repo: string, _prNumber: number, _jobName: string): Promise<ManualJobResult> {
  throw new Error('GitLabHost.runManualJob not implemented until run_manual_job Task 2');
}
```

- [ ] **Step 8: Typecheck + tests + full suite.** `npm run typecheck && npx vitest run src/ports/__tests__/capabilities.test.ts && npm test` → PASS.

- [ ] **Step 9: Commit.**
```bash
git add src/ports/repo-host-types.ts src/ports/repo-host.ts src/ports/capabilities.ts src/connectors/github/client.ts src/connectors/gitlab/client.ts src/ports/__tests__/capabilities.test.ts
git commit -m "feat(ports): add runManualJob to RepoHost + manualJobs capability (canonical)"
```

---

## Task 2: GitLab `runManualJob` implementation

**Files:** Modify `src/connectors/gitlab/client.ts` (replace the T1 stub), `src/connectors/gitlab/__tests__/client-write.test.ts`

**Interfaces:**
- Consumes: `glRequest`, `glRequestAll` (`./http.js`), `this.projectId`. Produces: real `runManualJob` → resolves MR head pipeline, finds the job by name, `POST /jobs/:id/play`, returns `{ id, url, status }`.

- [ ] **Step 1: Failing tests.** Append to `src/connectors/gitlab/__tests__/client-write.test.ts`:
```ts
describe('GitLabHost.runManualJob', () => {
  it('finds the named manual job in the MR pipeline and plays it', async () => {
    setEnv();
    const fetchMock = vi.fn()
      // 1) GET merge_requests/:iid -> head_pipeline
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'abc', head_pipeline: { id: 777 } }), { status: 200 }))
      // 2) GET pipelines/:id/jobs -> jobs list
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 11, name: 'build', status: 'success', web_url: 'u/11' },
        { id: 12, name: 'Ready to prod', status: 'manual', web_url: 'u/12' },
      ]), { status: 200 }))
      // 3) POST jobs/:id/play -> played job
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 12, status: 'pending', web_url: 'u/12' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new GitLabHost().runManualJob('walli/sweed/web-ui-cashier-ci', 1667, 'Ready to prod');
    expect(res).toEqual({ id: 12, url: 'u/12', status: 'pending' });

    // the third call is the play POST on the found job id
    const [url, init] = fetchMock.mock.calls[2];
    expect(String(url)).toContain('/projects/walli%2Fsweed%2Fweb-ui-cashier-ci/jobs/12/play');
    expect(init.method).toBe('POST');
  });

  it('throws when the named job is absent from the pipeline', async () => {
    setEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'abc', head_pipeline: { id: 777 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 11, name: 'build', status: 'success', web_url: 'u/11' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GitLabHost().runManualJob('g/p', 5, 'Ready to prod')).rejects.toThrow(/Ready to prod/);
  });

  it('throws when the MR has no pipeline', async () => {
    setEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: 'abc' }), { status: 200 })));
    await expect(new GitLabHost().runManualJob('g/p', 5, 'Ready to prod')).rejects.toThrow(/no pipeline/i);
  });
});
```

- [ ] **Step 2: Run, verify RED.** `npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts -t runManualJob` → FAIL (`not implemented until run_manual_job Task 2`).

- [ ] **Step 3: Implement** (replace the T1 stub in `src/connectors/gitlab/client.ts`):
```ts
async runManualJob(repo: string, prNumber: number, jobName: string): Promise<ManualJobResult> {
  const id = this.projectId(repo);
  // Resolve the MR's head pipeline, find the manual job by name, and play it.
  const mr = await glRequest<{ head_pipeline?: { id: number } }>({
    path: `/projects/${id}/merge_requests/${prNumber}`,
  });
  if (!mr.head_pipeline) {
    throw new Error(`MR !${prNumber} in ${repo} has no pipeline to run "${jobName}" on`);
  }
  const jobs = await glRequestAll<{ id: number; name: string; status: string; web_url: string | null }>({
    path: `/projects/${id}/pipelines/${mr.head_pipeline.id}/jobs`,
  });
  const job = jobs.find((j) => j.name === jobName);
  if (!job) {
    throw new Error(`No job named "${jobName}" in MR !${prNumber}'s pipeline (${repo})`);
  }
  const played = await glRequest<{ id: number; status: string; web_url: string | null }>({
    method: 'POST',
    path: `/projects/${id}/jobs/${job.id}/play`,
  });
  logger.system(`GitLab: played manual job "${jobName}" (${played.id}) on ${repo} MR !${prNumber} → ${played.status}`);
  return { id: played.id, url: played.web_url, status: played.status };
}
```
(`glRequestAll` is already imported in this file — used by `listPRChecks`.)

- [ ] **Step 4: Run tests + typecheck + full suite.** `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts && npm test` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-write.test.ts
git commit -m "feat(gitlab): runManualJob → resolve MR pipeline, find job by name, play it"
```

---

## Task 3: `run_manual_job` MCP tool (capability + edit-mode gated)

**Files:** Modify `src/agents/tools.ts` (add `createRunManualJobTool` + register), `src/agents/spawn.ts` (add to `REPO_TOOLS_REQUIRING_EDIT_MODE`), `src/agents/__tests__/pr-tools.test.ts`, `src/agents/__tests__/tool-contract.test.ts`

**Interfaces:**
- Consumes: `getRepoHost()`, `RepoHost.runManualJob`, `capabilities().manualJobs`, `tool`/`z`/`ok`/`err`. Produces: `run_manual_job` tool on the repo-tools server, in `REPO_TOOLS_REQUIRING_EDIT_MODE`.

> Model on `createDispatchWorkflowTool` (same file). Arg is a free `repo: z.string()` (not `resolveGithub`) — the caller targets an arbitrary repo's MR — same rationale as `dispatch_workflow`.

- [ ] **Step 1: Failing tests.** Append to `src/agents/__tests__/pr-tools.test.ts`:
```ts
describe('run_manual_job — capability + gating', () => {
  const makeHost = (manualJobs: boolean) => ({
    kind: 'gitlab' as const,
    capabilities: vi.fn().mockReturnValue({
      reviewStates: false, securityAlerts: false, nativeAutoMerge: true, reReviewRequest: false,
      workflowDispatch: true, manualJobs,
    }),
    runManualJob: vi.fn().mockResolvedValue({ id: 12, url: 'https://gl/-/jobs/12', status: 'pending' }),
  });
  beforeEach(() => { vi.clearAllMocks(); });

  it('short-circuits when manualJobs is off (no API call)', async () => {
    const host = makeHost(false);
    vi.mocked(getGitHubClient).mockReturnValue(host as any);
    const tool = getRepoTool(makeAgent(), makeTask(), 'run_manual_job');
    const result = await tool({ repo: 'g/p', pr_number: 1667, job_name: 'Ready to prod' }, {});
    expect(result.content[0].text).toMatch(/not available/i);
    expect(host.runManualJob).not.toHaveBeenCalled();
  });

  it('plays the job and returns its url when enabled', async () => {
    const host = makeHost(true);
    vi.mocked(getGitHubClient).mockReturnValue(host as any);
    const tool = getRepoTool(makeAgent(), makeTask(), 'run_manual_job');
    const result = await tool({ repo: 'walli/sweed/web-ui-cashier-ci', pr_number: 1667, job_name: 'Ready to prod' }, {});
    expect(host.runManualJob).toHaveBeenCalledWith('walli/sweed/web-ui-cashier-ci', 1667, 'Ready to prod');
    expect(result.content[0].text).toContain('https://gl/-/jobs/12');
  });
});
```

- [ ] **Step 2: Run, verify RED.** `npx vitest run src/agents/__tests__/pr-tools.test.ts -t "run_manual_job"` → FAIL (tool not found).

- [ ] **Step 3: Add the tool factory** in `src/agents/tools.ts` (near `createDispatchWorkflowTool`):
```ts
function createRunManualJobTool(agent: Agent, task: Task) {
  return tool(
    'run_manual_job',
    'Play a manual (gated) CI job by name in a merge/pull request\'s pipeline — e.g. a "Ready to prod" release-deploy job. ' +
    'Pass the repo, the MR/PR number, and the exact job name. Runs in-process (no token in the agent). ' +
    'Returns the played job\'s id, url, and status.',
    {
      // Free target repo (not resolveGithub): the caller plays a job on an arbitrary repo's MR,
      // not necessarily its own bound repo — same rationale as dispatch_workflow.
      repo: z.string().describe('Repo "group/project" (GitLab) or "owner/name" (GitHub) whose MR pipeline holds the job.'),
      pr_number: z.number().describe('The merge/pull request number whose pipeline holds the manual job.'),
      job_name: z.string().describe('Exact name of the manual job to play, e.g. "Ready to prod".'),
    },
    async (args) => {
      const client = getRepoHost();
      if (!client) throw new Error('Repo host not configured');
      if (!client.capabilities().manualJobs) {
        return err(`Running manual jobs is not available on this repo host (${client.kind}).`);
      }
      let res;
      try {
        res = await client.runManualJob(args.repo, args.pr_number, args.job_name);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      return ok(
        `Played "${args.job_name}" on ${args.repo} !${args.pr_number}` +
        (res.url ? ` — ${res.url}` : '') + (res.status ? ` (${res.status})` : ''),
      );
    },
  );
}
```

- [ ] **Step 4: Register** — add `createRunManualJobTool(agent, task)` to the same array in `createRepoToolsMcpServer` where `createDispatchWorkflowTool(agent, task)` is registered.

- [ ] **Step 5: Edit-mode gate** — in `src/agents/spawn.ts`, add `'mcp__repo-tools__run_manual_job'` to the `REPO_TOOLS_REQUIRING_EDIT_MODE` array (it's a prod deploy — same gate as `dispatch_workflow`). Then in `src/agents/__tests__/tool-contract.test.ts`: add `'mcp__repo-tools__run_manual_job'` to the `SPAWN_REPO_TOOLS` allowlist AND to the exact-equality list in the `read-only edit-mode gate` test (both are designed to grow with new tools).

- [ ] **Step 6: Run tests + typecheck + full suite.** `npm run typecheck && npx vitest run src/agents/__tests__/pr-tools.test.ts src/agents/__tests__/tool-contract.test.ts && npm test` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/agents/tools.ts src/agents/spawn.ts src/agents/__tests__/pr-tools.test.ts src/agents/__tests__/tool-contract.test.ts
git commit -m "feat(tools): run_manual_job tool (capability + edit-mode gated, in-process)"
```

---

## Self-Review
- **Spec coverage:** the design's "Core addition — run_manual_job seam" (port method + result type + `manualJobs` capability + GitLab impl playing the named MR-pipeline job + capability-gated, edit-mode-gated tool, GitHub capability-off stub) is covered by T1–T3.
- **Placeholder scan:** none — every step has complete code. The GitHub throw + GitLab T1 throw are intentional compiling scaffolding (GitLab replaced in T2; GitHub gated off).
- **Type consistency:** `ManualJobResult { id, url, status }` and `runManualJob(repo, prNumber, jobName)` identical across port/GitLab/GitHub/tool; capability `manualJobs` consistent; GitLab returns `{ id, url, status }` from the played job's `{ id, web_url, status }`. The pr-tools mock includes the current 4 capability flags + `workflowDispatch` (from the dispatch_workflow plan) + `manualJobs`.
- **Isolation/constraints:** GitLab REST only in `gitlab/client.ts`; tool capability-gated (GitLab true / GitHub false) AND edit-mode-gated (`REPO_TOOLS_REQUIRING_EDIT_MODE` + the guard test); no token in the agent; canonical naming throughout.
