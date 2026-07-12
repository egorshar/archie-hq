# Jira Flow · Plan 1 — `dispatch_workflow` (core RepoHost seam)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **REQUIRED READING before Task 1:**
> - `docs/plans/2026-07-06-jira-feature-flow-design.md` — the design (esp. the "Core addition" section + the dispatch mapping table).
> - `src/ports/repo-host.ts`, `src/ports/repo-host-types.ts`, `src/ports/capabilities.ts` — the port, canonical types, capability descriptors.
> - `src/connectors/gitlab/client.ts` + `src/connectors/gitlab/http.ts` (`glRequest`, `projectId`) — the GitLab impl surface.
> - `src/agents/tools.ts` — `createRepoToolsMcpServer` and the code-scanning tools (`createListCodeScanningAlertsTool`) as the **capability-gate template** for the new tool.

**Goal:** Add a generic, canonically-named `dispatch_workflow` capability to the repo-host seam — `RepoHost.dispatchWorkflow(repo, ref, opts)` + a `dispatch_workflow` MCP tool — so an agent can trigger a CI run (GitLab: a pipeline) entirely through the in-process RepoHost, with no token in the agent's sandbox. This is the only core piece of the Jira→feature-stand flow; everything else is plugin config (Plan 2).

**Architecture:** Follow the Phase-1 pattern exactly — canonical (GitHub-semantic) naming (`WorkflowRunReport`/`workflow_run` → `dispatchWorkflow`), GitLab maps its pipeline API into it, capability-gated so a host that can't do it degrades cleanly (like the code-scanning tools). GitHub gets a capability-off stub (real `workflow_dispatch` is deferred until needed — YAGNI).

**Tech Stack:** Node ≥20 (ESM, `.js` specifiers), TypeScript, Vitest ^4. GitLab via the existing `glRequest` helper; GitHub via the existing Octokit client.

## Global Constraints

- **Additive / zero behavior change.** No existing method changes behavior. Full suite (`npm test`) passes unmodified after every task; existing tests not edited. GitHub/Claude default path unaffected.
- **Canonical naming.** The tool/method/type use GitHub-semantic names (`dispatchWorkflow`, `WorkflowDispatchResult`, tool `dispatch_workflow`, capability `workflowDispatch`) — never GitLab-isms (`pipeline`, `trigger`). GitLab maps into them.
- **No secret in agents.** The tool calls `getRepoHost().dispatchWorkflow()` in the Archie process (which holds the token); the agent only passes args. Same as `create_pull_request`.
- **Capability-gated.** The tool short-circuits with a clear "not available on this repo host" when `capabilities().workflowDispatch` is false (mirror the code-scanning tools).
- **Vendor isolation.** GitLab REST only inside `src/connectors/gitlab/`; the port stays host-neutral.
- **Logging.** `logger` only, never `console.*`.
- **Commits.** Atomic, one per task; commit at task end (authorized; do not push).

## File Structure

Modified:
- `src/ports/repo-host-types.ts` — add `WorkflowDispatchResult`.
- `src/ports/repo-host.ts` — add `dispatchWorkflow` to the interface.
- `src/ports/capabilities.ts` — add `workflowDispatch` to `RepoHostCapabilities`; set it in `GITHUB_CAPABILITIES` (false) and `GITLAB_CAPABILITIES_DEFAULT` (true).
- `src/connectors/github/client.ts` — `dispatchWorkflow` stub (capability-off: throws a clear "not supported").
- `src/connectors/gitlab/client.ts` — real `dispatchWorkflow` (POST pipeline).
- `src/agents/tools.ts` — `dispatch_workflow` tool (capability-gated) + register it in `createRepoToolsMcpServer`.
- Tests: `src/ports/__tests__/capabilities.test.ts`, `src/connectors/gitlab/__tests__/client-write.test.ts`, `src/agents/__tests__/pr-tools.test.ts`.

## Task order
T1 (types + port + capability + compiling stubs on both clients) → T2 (GitLab real impl) → T3 (the tool).

---

## Task 1: Port method, result type, capability flag, compiling stubs

**Files:**
- Modify: `src/ports/repo-host-types.ts`, `src/ports/repo-host.ts`, `src/ports/capabilities.ts`, `src/connectors/github/client.ts`, `src/connectors/gitlab/client.ts`
- Modify: `src/ports/__tests__/capabilities.test.ts`

**Interfaces:**
- Produces: `WorkflowDispatchResult` (`{ id: number | string | null; url: string | null }`); `RepoHost.dispatchWorkflow(repo, ref, opts?)`; `RepoHostCapabilities.workflowDispatch: boolean`. Consumed by T2 (GitLab impl) and T3 (tool).

- [ ] **Step 1: Add the capability assertions (failing test).** In `src/ports/__tests__/capabilities.test.ts`, extend the existing GitHub + GitLab describe blocks:

```ts
// in the GitHub capabilities test:
expect(GITHUB_CAPABILITIES.workflowDispatch).toBe(false);
// add a GitLab-default assertion (import GITLAB_CAPABILITIES_DEFAULT at top):
it('gitlab defaults advertise workflowDispatch', () => {
  expect(GITLAB_CAPABILITIES_DEFAULT.workflowDispatch).toBe(true);
});
```
(Add `GITLAB_CAPABILITIES_DEFAULT` to the import from `../capabilities.js` if not already imported.)

- [ ] **Step 2: Run it, verify RED.**

Run: `npx vitest run src/ports/__tests__/capabilities.test.ts`
Expected: FAIL — `workflowDispatch` missing.

- [ ] **Step 3: Add the result type** to `src/ports/repo-host-types.ts` (near the other canonical shapes):

```ts
/**
 * Result of dispatching a CI workflow run (canonical). GitLab returns a pipeline
 * (id + web_url); GitHub's workflow_dispatch returns no body, so both may be null.
 */
export interface WorkflowDispatchResult {
  id: number | string | null;
  url: string | null;
}
```

- [ ] **Step 4: Add the port method** to `src/ports/repo-host.ts`. Add `WorkflowDispatchResult` to the type import from `./repo-host-types.js`, then in the `RepoHost` interface (near the CI methods):

```ts
  /**
   * Dispatch a CI workflow run on `ref` (canonical; GitHub `workflow_dispatch`).
   * GitLab maps this to triggering a pipeline (opts.inputs → pipeline variables).
   * Gated by capabilities().workflowDispatch.
   */
  dispatchWorkflow(repo: string, ref: string, opts?: { workflow?: string; inputs?: Record<string, string> }): Promise<WorkflowDispatchResult>;
```

- [ ] **Step 5: Add the capability flag** in `src/ports/capabilities.ts`. In the `RepoHostCapabilities` interface:

```ts
  /** can dispatch a CI workflow run / trigger a pipeline (GitHub workflow_dispatch; GitLab pipeline trigger). */
  workflowDispatch: boolean;
```
In `GITHUB_CAPABILITIES` add `workflowDispatch: false,` and in `GITLAB_CAPABILITIES_DEFAULT` add `workflowDispatch: true,`.

- [ ] **Step 6: Add the GitHub stub** in `src/connectors/github/client.ts` (capability is off, so this is never reached via the tool — a clear throw documents that). Add `WorkflowDispatchResult` to its `repo-host-types.js` type import, then add the method to the class:

```ts
async dispatchWorkflow(_repo: string, _ref: string, _opts?: { workflow?: string; inputs?: Record<string, string> }): Promise<WorkflowDispatchResult> {
  // GitHub Actions workflow_dispatch is not wired yet (workflowDispatch capability is false);
  // the tool layer gates on the capability, so this is unreachable in normal flow.
  throw new Error('dispatchWorkflow is not available on the GitHub repo host');
}
```

- [ ] **Step 7: Add the GitLab stub** in `src/connectors/gitlab/client.ts` (real impl in T2). Add `WorkflowDispatchResult` to its `repo-host-types.js` type import, then:

```ts
async dispatchWorkflow(_repo: string, _ref: string, _opts?: { workflow?: string; inputs?: Record<string, string> }): Promise<WorkflowDispatchResult> {
  throw new Error('GitLabHost.dispatchWorkflow not implemented until Plan 1 Task 2');
}
```

- [ ] **Step 8: Typecheck + tests + full suite.**

Run: `npm run typecheck && npx vitest run src/ports/__tests__/capabilities.test.ts && npm test`
Expected: PASS (both clients now satisfy `RepoHost`; capability tests green; suite unchanged otherwise).

- [ ] **Step 9: Commit.**

```bash
git add src/ports/repo-host-types.ts src/ports/repo-host.ts src/ports/capabilities.ts src/connectors/github/client.ts src/connectors/gitlab/client.ts src/ports/__tests__/capabilities.test.ts
git commit -m "feat(ports): add dispatchWorkflow to RepoHost + workflowDispatch capability (canonical)"
```

---

## Task 2: GitLab `dispatchWorkflow` implementation

**Files:**
- Modify: `src/connectors/gitlab/client.ts` (replace the T1 stub)
- Modify: `src/connectors/gitlab/__tests__/client-write.test.ts`

**Interfaces:**
- Consumes: `glRequest` (`./http.js`), `projectId`.
- Produces: real `dispatchWorkflow` → `POST /projects/:id/pipeline` with `{ ref, variables:[{key,value}] }`, returns `{ id, url }` from the pipeline.

- [ ] **Step 1: Write the failing test.** Append to `src/connectors/gitlab/__tests__/client-write.test.ts`:

```ts
describe('GitLabHost.dispatchWorkflow', () => {
  it('POSTs a pipeline with ref + array-form variables and returns id + url', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 2009999, web_url: 'https://gl.example/g/p/-/pipelines/2009999' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const host = new GitLabHost();
    const res = await host.dispatchWorkflow('flant/infra/review', 'ci-bot/us-trigger', {
      inputs: { WERF_NEW_NAMESPACE: 'feature-sweed-123', REVIEW_SERVER_BRANCH: 'feature/SWEED-123', US_BOT: 'true' },
    });
    expect(res).toEqual({ id: 2009999, url: 'https://gl.example/g/p/-/pipelines/2009999' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/projects/flant%2Finfra%2Freview/pipeline');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.ref).toBe('ci-bot/us-trigger');
    // variables must be the array form GitLab requires
    expect(body.variables).toEqual(expect.arrayContaining([
      { key: 'WERF_NEW_NAMESPACE', value: 'feature-sweed-123' },
      { key: 'REVIEW_SERVER_BRANCH', value: 'feature/SWEED-123' },
      { key: 'US_BOT', value: 'true' },
    ]));
  });

  it('sends an empty variables array when no inputs given', async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1, web_url: 'u' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await new GitLabHost().dispatchWorkflow('g/p', 'main');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts -t dispatchWorkflow`
Expected: FAIL — throws `not implemented until Plan 1 Task 2`.

- [ ] **Step 3: Implement** (replace the stub in `src/connectors/gitlab/client.ts`):

```ts
async dispatchWorkflow(repo: string, ref: string, opts: { workflow?: string; inputs?: Record<string, string> } = {}): Promise<WorkflowDispatchResult> {
  // GitLab triggers a pipeline on `ref`; opts.inputs → the pipeline's `variables`,
  // which GitLab requires in array form [{key,value}] with a JSON content-type.
  const variables = Object.entries(opts.inputs ?? {}).map(([key, value]) => ({ key, value }));
  const pipeline = await glRequest<{ id: number; web_url: string | null }>({
    method: 'POST',
    path: `/projects/${this.projectId(repo)}/pipeline`,
    body: { ref, variables },
  });
  logger.system(`GitLab: dispatched pipeline ${pipeline.id} on ${repo}@${ref} (${variables.length} vars)`);
  return { id: pipeline.id, url: pipeline.web_url };
}
```
(`opts.workflow` is unused on GitLab — pipelines run the ref's `.gitlab-ci.yml`; it exists for the canonical/GitHub shape.)

- [ ] **Step 4: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/connectors/gitlab/__tests__/client-write.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/gitlab/client.ts src/connectors/gitlab/__tests__/client-write.test.ts
git commit -m "feat(gitlab): dispatchWorkflow → POST pipeline (ref + array-form variables)"
```

---

## Task 3: `dispatch_workflow` MCP tool (capability-gated)

**Files:**
- Modify: `src/agents/tools.ts` (add `createDispatchWorkflowTool`; register it in `createRepoToolsMcpServer`)
- Modify: `src/agents/__tests__/pr-tools.test.ts`

**Interfaces:**
- Consumes: `getRepoHost()`, `RepoHost.dispatchWorkflow`, `capabilities().workflowDispatch`, the `z`/`tool`/`ok`/`err` helpers already in `tools.ts`.
- Produces: a `dispatch_workflow` tool on the repo-tools MCP server.

> Model this on `createListCodeScanningAlertsTool` (same file) for the capability-gate + null-host + error patterns. `inputs` is a free-form string→string map.
>
> **Deliberate deviation from the template:** the arg is `repo: z.string()`, NOT the template's `github: githubArgSchema` + `resolveGithub(agent, args.github)`. `resolveGithub` resolves against the *agent's own bound repos*; the feature-stand-manager dispatches on `flant/infra/review`, a repo it is not bound to, so it must pass the target repo directly. Add a one-line code comment saying so, so a future reader doesn't "fix" it back to `resolveGithub`.

- [ ] **Step 1: Write the failing tests.** Append to `src/agents/__tests__/pr-tools.test.ts`:

```ts
describe('dispatch_workflow — capability gating', () => {
  const makeHost = (workflowDispatch: boolean) => ({
    kind: 'gitlab' as const,
    capabilities: vi.fn().mockReturnValue({
      reviewStates: false, securityAlerts: false, nativeAutoMerge: true, reReviewRequest: false, workflowDispatch,
    }),
    dispatchWorkflow: vi.fn().mockResolvedValue({ id: 42, url: 'https://gl/-/pipelines/42' }),
  });

  beforeEach(() => { vi.clearAllMocks(); });

  it('short-circuits when workflowDispatch is off (no API call)', async () => {
    const host = makeHost(false);
    vi.mocked(getGitHubClient).mockReturnValue(host as any);
    const tool = getRepoTool(makeAgent(), makeTask(), 'dispatch_workflow');
    const result = await tool({ repo: 'flant/infra/review', ref: 'ci-bot/us-trigger', inputs: { US_BOT: 'true' } }, {});
    expect(result.content[0].text).toMatch(/not available/i);
    expect(host.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('dispatches and returns the pipeline url when enabled', async () => {
    const host = makeHost(true);
    vi.mocked(getGitHubClient).mockReturnValue(host as any);
    const tool = getRepoTool(makeAgent(), makeTask(), 'dispatch_workflow');
    const result = await tool({ repo: 'flant/infra/review', ref: 'ci-bot/us-trigger', inputs: { WERF_NEW_NAMESPACE: 'feature-sweed-123', US_BOT: 'true' } }, {});
    expect(host.dispatchWorkflow).toHaveBeenCalledWith('flant/infra/review', 'ci-bot/us-trigger', { inputs: { WERF_NEW_NAMESPACE: 'feature-sweed-123', US_BOT: 'true' } });
    expect(result.content[0].text).toContain('https://gl/-/pipelines/42');
  });
});
```

- [ ] **Step 2: Run, verify RED.**

Run: `npx vitest run src/agents/__tests__/pr-tools.test.ts -t "dispatch_workflow"`
Expected: FAIL — tool `dispatch_workflow` not found in server.

- [ ] **Step 3: Add the tool factory** in `src/agents/tools.ts` (near `createListCodeScanningAlertsTool`):

```ts
function createDispatchWorkflowTool(agent: Agent, task: Task) {
  return tool(
    'dispatch_workflow',
    'Trigger a CI workflow run on a ref (GitHub workflow_dispatch; GitLab pipeline). ' +
    'Use for actions like deploying a feature stand via a central pipeline. Pass the repo, the ref/branch to run, ' +
    'and inputs as a flat string map (they map to GitLab pipeline variables / GitHub workflow inputs). ' +
    'Returns the run/pipeline id and URL to watch.',
    {
      repo: z.string().describe('Repo "group/project" (GitLab) or "owner/name" (GitHub) to run the workflow in.'),
      ref: z.string().describe('Branch/ref to run the workflow on, e.g. "ci-bot/us-trigger".'),
      inputs: z.record(z.string()).optional().describe('Flat key→value params (GitLab pipeline variables / GitHub workflow inputs).'),
      workflow: z.string().optional().describe('GitHub only: the workflow file/id to dispatch. Ignored by GitLab.'),
    },
    async (args) => {
      const client = getRepoHost();
      if (!client) throw new Error('Repo host not configured');
      if (!client.capabilities().workflowDispatch) {
        return err(`Workflow dispatch is not available on this repo host (${client.kind}).`);
      }
      let res;
      try {
        res = await client.dispatchWorkflow(args.repo, args.ref, {
          ...(args.inputs ? { inputs: args.inputs } : {}),
          ...(args.workflow ? { workflow: args.workflow } : {}),
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      return ok(`Dispatched workflow on ${args.repo}@${args.ref}` + (res.url ? ` — ${res.url}` : res.id != null ? ` (id ${res.id})` : ''));
    },
  );
}
```

> Note: the test's `dispatchWorkflow` expectation is called with `{ inputs: {...} }` (no `workflow` key when absent) — the spread above omits `workflow`/`inputs` when undefined, matching that.

- [ ] **Step 4: Register the tool** in `createRepoToolsMcpServer` — add `createDispatchWorkflowTool(agent, task)` to the same array where `createListCodeScanningAlertsTool(agent, task)` / `createGetCheckRunTool(agent, task)` are registered.

- [ ] **Step 5: Run tests + typecheck + full suite.**

Run: `npm run typecheck && npx vitest run src/agents/__tests__/pr-tools.test.ts && npm test`
Expected: PASS (baseline + new). `pr-tools.test.ts` has no tool-set assertion, but `src/agents/__tests__/tool-contract.test.ts` DOES enumerate the exact repo-tools set (`SPAWN_REPO_TOOLS`). Add `'mcp__repo-tools__dispatch_workflow'` to that array — a pure, non-weakening allowlist addition (the array is designed to grow with each new registered tool). This is the intended maintenance, not a forbidden "edit existing tests to pass".

> Note: zod is v4 in this repo — `z.record` needs two args: `z.record(z.string(), z.string())`, not the one-arg v3 form.

- [ ] **Step 6: Commit.**

```bash
git add src/agents/tools.ts src/agents/__tests__/pr-tools.test.ts
git commit -m "feat(tools): dispatch_workflow tool (capability-gated, in-process via RepoHost)"
```

---

## Self-Review

- **Spec coverage:** the design's "Core addition" (RepoHost.dispatchWorkflow + capability + GitLab impl + dispatch_workflow tool, canonical naming, no secret in agent, capability-gated) is fully covered by T1–T3. GitHub is capability-off stub (design said "GitHub: workflow_dispatch or capability-off" — off chosen, YAGNI). Plugin files (PM overlay, dev agents, feature-stand-manager, repos.yml/review.yml/.mcp.json) are **Plan 2** (archie-plugins repo), out of scope here.
- **Placeholder scan:** none; every step has complete code. The GitHub `throw` and GitLab T1 `throw` are intentional compiling scaffolding (GitLab replaced in T2; GitHub gated off).
- **Type consistency:** `WorkflowDispatchResult { id, url }` used consistently; `dispatchWorkflow(repo, ref, opts?)` signature identical across port/GitLab/GitHub/tool; capability `workflowDispatch` consistent; GitLab returns `{ id, url }` from `{ id, web_url }`.
- **Isolation/constraints:** GitLab REST only in `gitlab/client.ts` via `glRequest`; tool gates on capability (GitLab true, GitHub false); no token in the agent (tool runs in-process); canonical naming throughout.
