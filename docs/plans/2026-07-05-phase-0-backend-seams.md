# Phase 0 — Backend Seam Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract four backend seams (`RepoHost`, `RepoHostEventSource`, `AgentRuntime`, `LlmOneShot`) into a `src/ports/` package with a `src/system/backends.ts` resolver, make the existing GitHub + Claude-Agent-SDK code conform to them, and consolidate all vendor imports — with zero behavior change on the default config.

**Architecture:** Interface-first extraction (spec principle P2). Each seam gets a port interface in `src/ports/`; the existing implementation is made to conform (GitHub `GitHubClient` → `RepoHost`; `spawnAgent` → `AgentRuntime`; the four one-shot `query()` sites → `LlmOneShot`; the host-agnostic webhook router → `src/connectors/shared/cr-router.ts`). A single `src/system/backends.ts` resolves config → concrete factories (only `github`/`claude` options exist in Phase 0). All `@anthropic-ai/claude-agent-sdk` imports funnel through a `src/runtime/claude/` barrel so the isolation grep passes.

**Tech Stack:** Node ≥20 (ESM, `"type":"module"`), TypeScript ^6, Vitest ^4, zod ^4 (+ `zod-to-json-schema` ^3), `@octokit/app` ^16, `@anthropic-ai/claude-agent-sdk` ^0.3, `gray-matter`, Slack Bolt. Import specifiers use the `.js` extension (NodeNext resolution).

## Global Constraints

- **P1 — Additive / zero behavior change.** No task removes or breaks the GitHub/Claude path. The full test suite (`npm test`) must pass **unmodified** after every task. New tests may be added; existing tests may not be edited to accommodate a change (if an existing test would need editing, the change is wrong).
- **Default config stays default.** `REPO_HOST` defaults to `github`, `AGENT_RUNTIME` defaults to `claude`. With no new env vars set, boot and runtime behavior are identical to pre-refactor.
- **Vendor-import isolation (acceptance gate).** After Phase 0: `grep -rn "@octokit" src --include="*.ts" | grep -v "connectors/github"` → empty (already true today; keep it true). `grep -rn "claude-agent-sdk" src --include="*.ts" | grep -v "runtime/claude"` → empty except the single re-export barrel `src/runtime/claude/sdk.ts`.
- **Logging.** Never use `console.*`. Use `logger` from `src/system/logger.ts` (category string first arg, e.g. `logger.system(...)`, `logger.warn('backends', ...)`).
- **Prose wrapping.** In Markdown/comments, one line per paragraph/bullet — never hard-wrap prose. Only code may span fixed-width lines.
- **Commits.** Atomic, one logical change per commit. Commit at the end of each task (the user has authorized commits for this plan's execution; do not push).
- **Naming (Phase 0 only).** Keep PR-oriented method names (`getPRStatus`, `mergePullRequest`, …) on the `RepoHost` interface — 1:1 with the current `GitHubClient`. Neutral CR renaming is Phase 4, out of scope here.

## Deviations from spec §3.1 (deliberate, Phase-0 pragmatic)

- The spec proposes CR-named methods (`getCRStatus`, `createChangeRequest`). Real code uses `getPRStatus`, `createPullRequest`, etc. Phase 0 keeps the real PR names to keep tests unmodified; rename is Phase 4.
- The spec's `security?: { listAlerts, getAlert }` capability sub-object is deferred to Phase 1 (when GitLab needs the gap). Phase 0 keeps the flat `listCodeScanningAlerts` / `getCodeScanningAlert` methods on the interface so `tools.ts` is a mechanical `getGitHubClient()` → `getRepoHost()` swap.
- `askpassToken()` is declared **optional** (`askpassToken?()`) on the interface and implemented as a thin installation-token accessor; it is not yet wired into the `GIT_ASKPASS` flow (that stays script-driven until Phase 1's GitLab token provider needs it).
- The full `AgentSpawnSpec` / `RuntimeEvent` normalization (spec §3.3) is Phase 2. Phase 0's `AgentRuntime.spawn(agent, task)` keeps the existing `(agent, task)` call shape — this is a call-surface indirection only, not an event-model rewrite.
- Domain types (`PRStatus`, `PRReview`, `ReviewThread`, `PRComment`, `MergeableState`, `CheckConclusion`, `PRCheckEntry`, `PRChecksReport`) currently live in `src/agents/tools.ts:138-212`. They move to `src/ports/repo-host-types.ts`; `tools.ts` re-exports them so every existing importer is unaffected.

## File Structure

New files:
- `src/ports/repo-host-types.ts` — canonical host-neutral domain types (moved from `tools.ts`).
- `src/ports/capabilities.ts` — `RepoHostCapabilities`, `RuntimeCapabilities` descriptors.
- `src/ports/repo-host.ts` — `RepoHost` interface.
- `src/ports/repo-host-events.ts` — `RepoHostEventSource` interface + normalized event/route types.
- `src/ports/agent-runtime.ts` — `AgentRuntime` interface (Phase-0 minimal).
- `src/ports/llm-one-shot.ts` — `LlmOneShot` interface + request types.
- `src/ports/index.ts` — barrel re-export of the above.
- `src/system/backends.ts` — config resolver: `resolveBackends()`, `getRepoHost()`, `getAgentRuntime()`, `getLlmOneShot()`, `getBackendMatrix()`.
- `src/connectors/shared/cr-router.ts` — host-agnostic routing (moved from `github/webhooks.ts`).
- `src/connectors/shared/__tests__/cr-router.test.ts` — characterization tests for the moved router.
- `src/runtime/claude/sdk.ts` — single re-export barrel for the Claude Agent SDK.
- `src/runtime/claude/runtime.ts` — `ClaudeSdkRuntime` implementing `AgentRuntime`.
- `src/runtime/claude/llm-one-shot.ts` — `ClaudeLlmOneShot` implementing `LlmOneShot`.
- `src/system/__tests__/backends.test.ts` — resolver + validation tests.
- `docs/architecture/backends.md` — architecture doc for the abstraction.

Modified files (surgical): `src/agents/tools.ts`, `src/agents/mcp-file-bridge.ts`, `src/agents/sandbox.ts`, `src/agents/spawn.ts`, `src/mcp/research-tools.ts`, `src/agents/agent.ts`, `src/connectors/github/client.ts`, `src/connectors/github/merge.ts`, `src/connectors/github/webhooks.ts`, `src/tasks/title-generator.ts`, `src/memory/extractor.ts`, `src/memory/housekeeping.ts`, `src/system/triage.ts`, `src/index.ts`, `CLAUDE.md`.

## Task dependency order

Group A (ports foundation, pure additions) → Group B (RepoHost conformance + backends resolver + route callers) → Group C (shared CR router) → Group D (Claude SDK barrel + AgentRuntime) → Group E (LlmOneShot + migrate 4 one-shot sites) → Group F (boot wiring + docs + final acceptance). A precedes all. Within B, Task 8 precedes 9–11. D-Task-14 (barrel) precedes E (so migrated sites and remaining SDK importers share one barrel). F is last.

---

## Group A — Ports foundation

### Task 1: Move domain types to `src/ports/repo-host-types.ts`

**Files:**
- Create: `src/ports/repo-host-types.ts`
- Modify: `src/agents/tools.ts:138-212` (remove the type declarations, add a re-export)
- Modify: `src/connectors/github/client.ts` (its `import type { ... } from '../../agents/tools.js'` line — repoint to ports)

**Interfaces:**
- Produces: the types `MergeableState`, `PRStatus`, `PRReview`, `ReviewThread`, `ReviewThreadComment`, `PRComment`, `CheckConclusion`, `PRCheckEntry`, `PRChecksReport` (exact names/shapes preserved). All later tasks import these from `src/ports/repo-host-types.js`.

- [ ] **Step 1: Read the current type block.** Read `src/agents/tools.ts:138-212` and copy the exact declarations of `MergeableState`, `PRStatus`, `PRReview`, `ReviewThread`, `ReviewThreadComment`, `PRComment`, `CheckConclusion`, `PRCheckEntry`, `PRChecksReport` (and any small helper types they reference in that range). Note: do NOT invent shapes — transcribe verbatim.

- [ ] **Step 2: Create `src/ports/repo-host-types.ts`** with the verbatim declarations under a file header. Skeleton (fill the `// … verbatim …` blocks from Step 1):

```ts
/**
 * Host-neutral repo-host domain types.
 *
 * These describe change-requests, reviews, and CI in a vendor-agnostic shape.
 * They were extracted verbatim from src/agents/tools.ts as part of the Phase 0
 * RepoHost seam. GitHub and (later) GitLab hosts both produce these shapes.
 */

export type MergeableState = 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'unknown';

export interface PRStatus {
  state: 'open' | 'merged' | 'closed';
  mergeable: boolean;
  mergeableState: MergeableState;
  approved: boolean;
}

// … verbatim: PRReview, ReviewThread, ReviewThreadComment, PRComment,
//    CheckConclusion, PRCheckEntry, PRChecksReport …
```

- [ ] **Step 3: Replace the declarations in `tools.ts` with a re-export.** Delete lines 138-212's type declarations and put in their place:

```ts
// Host-neutral repo-host domain types live in the ports layer now. Re-exported
// here so existing importers (`from '../../agents/tools.js'`) keep working.
export type {
  MergeableState,
  PRStatus,
  PRReview,
  ReviewThread,
  ReviewThreadComment,
  PRComment,
  CheckConclusion,
  PRCheckEntry,
  PRChecksReport,
} from '../ports/repo-host-types.js';
```

- [ ] **Step 4: Repoint `client.ts`'s type import.** In `src/connectors/github/client.ts`, change the `import type { PRStatus, PRReview, ReviewThread, PRComment, ... } from '../../agents/tools.js'` line to import those same names from `'../../ports/repo-host-types.js'`. (Leave any non-domain imports from `tools.js` alone.)

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`
Expected: PASS (0 errors). If an importer breaks, it was importing a domain type from `tools.js` — the re-export in Step 3 should cover it; verify the name is in the re-export list.

- [ ] **Step 6: Run the full suite.**

Run: `npm test`
Expected: PASS, same count as baseline. (Run `npm test` once before starting Task 1 to record the baseline pass count.)

- [ ] **Step 7: Commit.**

```bash
git add src/ports/repo-host-types.ts src/agents/tools.ts src/connectors/github/client.ts
git commit -m "refactor(ports): extract host-neutral repo-host domain types"
```

### Task 2: Capability descriptors — `src/ports/capabilities.ts`

**Files:**
- Create: `src/ports/capabilities.ts`

**Interfaces:**
- Produces: `RepoHostCapabilities`, `RuntimeCapabilities` interfaces + the const `GITHUB_CAPABILITIES: RepoHostCapabilities` and `CLAUDE_RUNTIME_CAPABILITIES: RuntimeCapabilities`.

- [ ] **Step 1: Write the failing test.** Create `src/ports/__tests__/capabilities.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GITHUB_CAPABILITIES, CLAUDE_RUNTIME_CAPABILITIES } from '../capabilities.js';

describe('capability descriptors', () => {
  it('github advertises reviews, security alerts, re-review; no native auto-merge', () => {
    expect(GITHUB_CAPABILITIES.reviewStates).toBe(true);
    expect(GITHUB_CAPABILITIES.securityAlerts).toBe(true);
    expect(GITHUB_CAPABILITIES.reReviewRequest).toBe(true);
    expect(GITHUB_CAPABILITIES.nativeAutoMerge).toBe(false);
  });

  it('claude runtime advertises OS sandbox, skills, 1M context', () => {
    expect(CLAUDE_RUNTIME_CAPABILITIES.osSandbox).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.skills).toBe(true);
    expect(CLAUDE_RUNTIME_CAPABILITIES.oneMillionContext).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/ports/__tests__/capabilities.test.ts`
Expected: FAIL — cannot find module `../capabilities.js`.

- [ ] **Step 3: Write `src/ports/capabilities.ts`.**

```ts
/**
 * Capability descriptors (spec principle P3): where a backend cannot match a
 * capability, the gap is declared here and degraded gracefully — never silent.
 */

export interface RepoHostCapabilities {
  /** true: distinct approved / changes_requested review states (GitHub). false: approvals+notes only (GitLab). */
  reviewStates: boolean;
  /** code-scanning / security alerts available (GitHub, GitLab Ultimate). */
  securityAlerts: boolean;
  /** host-native "merge when pipeline succeeds" (GitLab). Archie orchestrates merges itself when false. */
  nativeAutoMerge: boolean;
  /** can request re-review from prior reviewers. */
  reReviewRequest: boolean;
}

export interface RuntimeCapabilities {
  /** built-in OS-level sandbox (Claude SDK bubblewrap). */
  osSandbox: boolean;
  /** native Skills support. */
  skills: boolean;
  /** 1M-context models available. */
  oneMillionContext: boolean;
  /** per-turn reasoning-effort control. */
  effort: boolean;
  /** background/subagent tasks surfaced as events. */
  backgroundTasks: boolean;
}

export const GITHUB_CAPABILITIES: RepoHostCapabilities = {
  reviewStates: true,
  securityAlerts: true,
  nativeAutoMerge: false,
  reReviewRequest: true,
};

export const CLAUDE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  osSandbox: true,
  skills: true,
  oneMillionContext: true,
  effort: true,
  backgroundTasks: true,
};
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/ports/__tests__/capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/ports/capabilities.ts src/ports/__tests__/capabilities.test.ts
git commit -m "feat(ports): add repo-host and runtime capability descriptors"
```

### Task 3: `RepoHost` interface — `src/ports/repo-host.ts`

**Files:**
- Create: `src/ports/repo-host.ts`

**Interfaces:**
- Consumes: domain types from `repo-host-types.js` (Task 1); `RepoHostCapabilities` (Task 2); `CreatePRResult`, `PRDetails`, `PRListItem`, `PRListFilters`, `CheckRunReport`, `WorkflowRunReport`, `CodeScanningAlert`, `CodeScanningAlertFilters` from `src/connectors/github/client.js`, and `PrCardData` from `src/types/task.js`.
- Produces: `RepoHost` interface. Task 8 makes `GitHubClient implements RepoHost`; Tasks 10–11 type callers as `RepoHost`.

> Note on type sourcing: `CreatePRResult`, `PRDetails`, `PRListItem`, `PRListFilters`, `CheckRunReport`, `WorkflowRunReport`, `CodeScanningAlert`, `CodeScanningAlertFilters` are currently declared in `client.ts` and are already host-neutral in shape. Phase 0 imports them from `client.ts` to avoid a second type move; a later phase may relocate them into ports. This keeps the interface honest without extra churn.

- [ ] **Step 1: Write `src/ports/repo-host.ts`.**

```ts
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
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS. (This file is type-only; a failure means a referenced type name/path is wrong — cross-check against the `client.ts` exports listed in the map.)

- [ ] **Step 3: Commit.**

```bash
git add src/ports/repo-host.ts
git commit -m "feat(ports): add RepoHost interface"
```

### Task 4: `RepoHostEventSource` interface + route types — `src/ports/repo-host-events.ts`

**Files:**
- Create: `src/ports/repo-host-events.ts`

**Interfaces:**
- Produces: `NormalizedEventContext`, `InternalRouteAction`, `RouteResult`, `RepoHostEventSource`. Task 12 (cr-router) consumes `NormalizedEventContext`/`InternalRouteAction`/`RouteResult`; Task 13 makes GitHub's webhook module conform to `RepoHostEventSource`.

> These generalize the current `GitHubEventContext` (webhooks.ts:44), `InternalRouteAction` (webhooks.ts:360), and `GitHubRouteResult` (webhooks.ts:346). The field set is copied from `GitHubEventContext` so the GitHub parser maps 1:1.

- [ ] **Step 1: Write `src/ports/repo-host-events.ts`.**

```ts
/**
 * RepoHostEventSource — inbound webhook seam (spec §3.2). Signature verification
 * and payload parsing stay per-host; the normalized context + routing decision
 * are host-agnostic (see src/connectors/shared/cr-router.ts).
 */

/** Host-neutral normalized event, produced by each host's payload parser. */
export interface NormalizedEventContext {
  /** host-native event type string, e.g. 'pull_request', 'Merge Request Hook'. */
  eventType: string;
  action?: string;
  /** repo identifier "owner/name" (GitHub) / "group/project" (GitLab). */
  repo: string;
  prNumber?: number;
  branch?: string;
  user: string;
  body?: string;
  state?: string;
  commentId?: number;
}

/** Internal routing semantic — host-agnostic. */
export type InternalRouteAction = 'merge_check' | 'existing_task' | 'checks_ready' | 'noop';

/** Routing decision, consumed by the HTTP dispatcher. */
export type RouteResult =
  | { action: 'discard'; reason: string }
  | { action: 'direct'; handler: 'merge_check' | 'existing_task'; taskId: string }
  | { action: 'direct'; handler: 'checks_ready'; taskId: string; repo: string; prNumber: number };

export interface RepoHostEventSource {
  readonly kind: 'github' | 'gitlab';
  /** constant-time signature/token check over the raw body. */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean;
  /** parse a raw payload into the host-neutral context. */
  parseEvent(eventType: string, payload: unknown): NormalizedEventContext;
  /** true when the event originated from our own bot (loop guard); machine events exempt. */
  isSelfEvent(context: NormalizedEventContext): boolean;
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/ports/repo-host-events.ts
git commit -m "feat(ports): add RepoHostEventSource interface and normalized route types"
```

### Task 5: `AgentRuntime` interface — `src/ports/agent-runtime.ts`

**Files:**
- Create: `src/ports/agent-runtime.ts`

**Interfaces:**
- Consumes: `RuntimeCapabilities` (Task 2); `Agent` (`src/agents/agent.js`), `Task` (`src/tasks/task.js`) — type-only.
- Produces: `AgentRuntime` interface. Task 15 implements `ClaudeSdkRuntime`; Task 15 also rewires `agent.ts` to call `getAgentRuntime().spawn(...)`.

> Phase-0 minimal shape: `spawn(agent, task): Promise<void>` — identical call shape to the current `spawnAgent(agent, task)`, which mutates `agent` (sets `agent.handle`). The rich `AgentSpawnSpec`/`RuntimeEvent` model is Phase 2.

- [ ] **Step 1: Write `src/ports/agent-runtime.ts`.**

```ts
/**
 * AgentRuntime — the agent-runtime seam (spec §3.3). ClaudeSdkRuntime today;
 * OpencodeRuntime in Phase 2. Phase-0 shape mirrors the existing spawnAgent
 * contract: spawn() mutates `agent` (sets agent.handle) and resolves when setup
 * is done. The AgentSpawnSpec/RuntimeEvent normalization arrives in Phase 2.
 */

import type { RuntimeCapabilities } from './capabilities.js';
import type { Agent } from '../agents/agent.js';
import type { Task } from '../tasks/task.js';

export interface AgentRuntime {
  readonly kind: 'claude' | 'opencode';
  capabilities(): RuntimeCapabilities;
  /**
   * Spawn `agent` for `task`. Mutates `agent` (sets agent.sandbox, agent.handle).
   * Idempotency and crash-detection wiring remain in Agent.spawn(); this is the
   * runtime-specific process launch.
   */
  spawn(agent: Agent, task: Task): Promise<void>;
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS. (If a circular type import warning surfaces, it is type-only and erased — acceptable.)

- [ ] **Step 3: Commit.**

```bash
git add src/ports/agent-runtime.ts
git commit -m "feat(ports): add AgentRuntime interface (phase-0 minimal shape)"
```

### Task 6: `LlmOneShot` interface — `src/ports/llm-one-shot.ts`

**Files:**
- Create: `src/ports/llm-one-shot.ts`

**Interfaces:**
- Produces: `LlmTextRequest`, `LlmJsonRequest`, `LlmOneShot`. Task 17 implements `ClaudeLlmOneShot`; Tasks 18–21 call it.

> Two modes matching the real call sites: `text()` (extractor, housekeeping — accumulate assistant text / result string, caller parses downstream) and `json()` (title, triage — SDK `outputFormat` structured output; caller keeps its own zod build + `safeParse`). The port owns the `query()` plumbing + env allowlist; callers keep schema construction and validation so behavior is byte-identical.

- [ ] **Step 1: Write `src/ports/llm-one-shot.ts`.**

```ts
/**
 * LlmOneShot — a plain one-shot LLM call (spec §3.4): prompt in → text/JSON out.
 * Used by title generation, memory extraction/housekeeping, and (disabled)
 * triage. Claude-SDK impl today; opencode impl in Phase 2.
 */

export interface LlmTextRequest {
  prompt: string;
  systemPrompt?: string;
  /** runtime-specific model id resolved by the caller for now ('haiku' | 'sonnet' | …). */
  model: string;
  maxTurns?: number;
  /** built-in tools to allow (triage allows Glob/Grep/Read); default none. */
  allowedTools?: string[];
  /** working directory for the one-shot process (triage uses the sessions dir). */
  cwd?: string;
  /** optional stderr sink for debug (extractor/housekeeping). */
  stderr?: (data: string) => void;
}

export interface LlmJsonRequest extends LlmTextRequest {
  /** caller-built JSON Schema for structured output. Caller validates the result itself. */
  jsonSchema: Record<string, unknown>;
}

export interface LlmOneShot {
  readonly kind: 'claude' | 'opencode';
  /** Free-text completion. Returns final text, or null on failure/non-success. */
  text(req: LlmTextRequest): Promise<string | null>;
  /** Structured completion. Returns the raw structured output (caller validates), or null. */
  json(req: LlmJsonRequest): Promise<unknown | null>;
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/ports/llm-one-shot.ts
git commit -m "feat(ports): add LlmOneShot interface"
```

### Task 7: Ports barrel — `src/ports/index.ts`

**Files:**
- Create: `src/ports/index.ts`

**Interfaces:**
- Produces: a single import surface `src/ports/index.js` re-exporting every ports type.

- [ ] **Step 1: Write `src/ports/index.ts`.**

```ts
export * from './repo-host-types.js';
export * from './capabilities.js';
export * from './repo-host.js';
export * from './repo-host-events.js';
export * from './agent-runtime.js';
export * from './llm-one-shot.js';
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/ports/index.ts
git commit -m "feat(ports): add ports barrel"
```

---

## Group B — RepoHost conformance + backends resolver + route callers

### Task 8: Make `GitHubClient implements RepoHost`

**Files:**
- Modify: `src/connectors/github/client.ts` (class decl `client.ts:246`; add small methods; import ports types)

**Interfaces:**
- Consumes: `RepoHost` (Task 3), `RepoHostCapabilities` + `GITHUB_CAPABILITIES` (Task 2), free fns `getGitHubAppIdentity` (`client.ts:1208`), `githubRepoToUrl` (`repo-clone.ts:24`).
- Produces: `class GitHubClient implements RepoHost` with new members `kind`, `capabilities()`, `botIdentity()`, `cloneUrl()`, optional `askpassToken()`. Task 9 returns this as `RepoHost`.

- [ ] **Step 1: Add imports at the top of `client.ts`.**

```ts
import type { RepoHost } from '../../ports/repo-host.js';
import type { RepoHostCapabilities } from '../../ports/capabilities.js';
import { GITHUB_CAPABILITIES } from '../../ports/capabilities.js';
import { githubRepoToUrl } from './repo-clone.js';
```

(If `client.ts` and `repo-clone.ts` would form an import cycle — `repo-clone.ts` re-exports `fetchOrigin` from `client.ts` — verify at typecheck. If a cycle causes a runtime issue, inline the URL: `` `https://github.com/${repo}.git` `` instead of importing `githubRepoToUrl`. Prefer the import; fall back only if the cycle bites.)

- [ ] **Step 2: Change the class declaration** at `client.ts:246` from `export class GitHubClient {` to `export class GitHubClient implements RepoHost {`.

- [ ] **Step 3: Add the five interface members** inside the class (near the top, after the constructor). `getGitHubAppIdentity` is a module free function already in this file.

```ts
readonly kind = 'github' as const;

capabilities(): RepoHostCapabilities {
  return GITHUB_CAPABILITIES;
}

botIdentity(): { name: string; email: string } | null {
  return getGitHubAppIdentity();
}

cloneUrl(repo: string): string {
  return githubRepoToUrl(repo);
}
```

(Do NOT add `askpassToken()` — it is optional and deferred. Leaving it off is valid because the interface marks it optional.)

- [ ] **Step 4: Typecheck — this surfaces any signature mismatch.**

Run: `npm run typecheck`
Expected: PASS. If TS reports "Class 'GitHubClient' incorrectly implements interface 'RepoHost'", the error names the offending method — reconcile the interface (Task 3) signature with the real method signature (the map lists them). Any true divergence is a Task 3 interface bug; fix it there, re-run. Do not change GitHubClient method behavior.

- [ ] **Step 5: Run the full suite.**

Run: `npm test`
Expected: PASS (baseline count). No behavior changed — only a type conformance annotation and three pure accessor methods were added.

- [ ] **Step 6: Commit.**

```bash
git add src/connectors/github/client.ts
git commit -m "refactor(github): make GitHubClient implement RepoHost"
```

### Task 9: `src/system/backends.ts` — RepoHost resolver + config validation

**Files:**
- Create: `src/system/backends.ts`
- Create: `src/system/__tests__/backends.test.ts`

**Interfaces:**
- Consumes: `RepoHost` (Task 3), `getGitHubClient` (`client.ts:1259`).
- Produces: `getRepoHost(): RepoHost | null`, `resolveRepoHostKind(): 'github' | 'gitlab'`, `assertBackendConfig(): void`, `getBackendMatrix(): { repoHost: string; runtime: string }`. Tasks 10–11 call `getRepoHost()`; Task 16 extends this file with runtime resolution; Task 23 calls `assertBackendConfig()` + `getBackendMatrix()`.

- [ ] **Step 1: Write the failing test.** Create `src/system/__tests__/backends.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveRepoHostKind, assertBackendConfig, getBackendMatrix } from '../backends.js';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe('backends config resolver', () => {
  it('defaults repo host to github when REPO_HOST is unset', () => {
    delete process.env.REPO_HOST;
    expect(resolveRepoHostKind()).toBe('github');
  });

  it('honors REPO_HOST=github explicitly', () => {
    process.env.REPO_HOST = 'github';
    expect(resolveRepoHostKind()).toBe('github');
  });

  it('rejects an unknown REPO_HOST value', () => {
    process.env.REPO_HOST = 'bitbucket';
    expect(() => assertBackendConfig()).toThrow(/REPO_HOST/);
  });

  it('rejects gitlab in phase 0 (not yet implemented)', () => {
    process.env.REPO_HOST = 'gitlab';
    expect(() => assertBackendConfig()).toThrow(/not available|gitlab/i);
  });

  it('reports the resolved matrix', () => {
    delete process.env.REPO_HOST;
    delete process.env.AGENT_RUNTIME;
    expect(getBackendMatrix()).toEqual({ repoHost: 'github', runtime: 'claude' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/system/__tests__/backends.test.ts`
Expected: FAIL — cannot find module `../backends.js`.

- [ ] **Step 3: Write `src/system/backends.ts`.**

```ts
/**
 * Backend resolver (spec §3, §4). Resolves REPO_HOST / AGENT_RUNTIME env into
 * concrete backend factories + capabilities. Phase 0 supports exactly one option
 * per seam (github / claude); the resolver exists so later phases add options
 * without touching call sites. Fails fast with actionable messages at boot.
 */

import type { RepoHost } from '../ports/repo-host.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { logger } from './logger.js';

export type RepoHostKind = 'github' | 'gitlab';
export type AgentRuntimeKind = 'claude' | 'opencode';

const SUPPORTED_REPO_HOSTS: RepoHostKind[] = ['github']; // gitlab: Phase 1
const SUPPORTED_RUNTIMES: AgentRuntimeKind[] = ['claude']; // opencode: Phase 2

export function resolveRepoHostKind(): RepoHostKind {
  const raw = (process.env.REPO_HOST ?? 'github').trim().toLowerCase();
  return raw as RepoHostKind;
}

export function resolveAgentRuntimeKind(): AgentRuntimeKind {
  const raw = (process.env.AGENT_RUNTIME ?? 'claude').trim().toLowerCase();
  return raw as AgentRuntimeKind;
}

export function getBackendMatrix(): { repoHost: string; runtime: string } {
  return { repoHost: resolveRepoHostKind(), runtime: resolveAgentRuntimeKind() };
}

/**
 * Validate selected backends are supported in this build. Throw with an
 * actionable message otherwise. Call once at boot (see index.ts).
 */
export function assertBackendConfig(): void {
  const host = resolveRepoHostKind();
  if (!SUPPORTED_REPO_HOSTS.includes(host)) {
    const known: string[] = ['github', 'gitlab'];
    if (known.includes(host)) {
      throw new Error(`REPO_HOST="${host}" is not available in this build yet (Phase 0 supports: ${SUPPORTED_REPO_HOSTS.join(', ')}).`);
    }
    throw new Error(`REPO_HOST="${host}" is invalid. Supported values: ${SUPPORTED_REPO_HOSTS.join(', ')}.`);
  }
  const runtime = resolveAgentRuntimeKind();
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    const known: string[] = ['claude', 'opencode'];
    if (known.includes(runtime)) {
      throw new Error(`AGENT_RUNTIME="${runtime}" is not available in this build yet (Phase 0 supports: ${SUPPORTED_RUNTIMES.join(', ')}).`);
    }
    throw new Error(`AGENT_RUNTIME="${runtime}" is invalid. Supported values: ${SUPPORTED_RUNTIMES.join(', ')}.`);
  }
}

/**
 * The active RepoHost, or null when the host is unconfigured (e.g. GitHub App
 * env absent — mirrors getGitHubClient() returning null; callers already handle
 * a null host by disabling PR tools).
 */
export function getRepoHost(): RepoHost | null {
  const host = resolveRepoHostKind();
  switch (host) {
    case 'github':
      return getGitHubClient();
    default:
      // Unsupported hosts are rejected by assertBackendConfig() at boot; return
      // null defensively so a mis-sequenced call can't crash.
      logger.warn('backends', `getRepoHost() called for unsupported host "${host}"`);
      return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run src/system/__tests__/backends.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite + typecheck.**

Run: `npm run typecheck && npm test`
Expected: PASS (baseline + 5 new).

- [ ] **Step 6: Commit.**

```bash
git add src/system/backends.ts src/system/__tests__/backends.test.ts
git commit -m "feat(backends): add config resolver with RepoHost factory and validation"
```

### Task 10: Route `tools.ts` repo tools through `getRepoHost()`

**Files:**
- Modify: `src/agents/tools.ts` (import at `tools.ts:20`; every `getGitHubClient()` call site inside `repo-tools` + the two orchestration tools)

**Interfaces:**
- Consumes: `getRepoHost()` (Task 9).
- Produces: no signature change — tools obtain a `RepoHost` instead of a `GitHubClient`. Behavior identical (same singleton object).

- [ ] **Step 1: Swap the import.** In `src/agents/tools.ts`, change the import that brings in `getGitHubClient` (`tools.ts:20`) to also/instead import `getRepoHost` from backends. Replace:

```ts
import { getGitHubClient } from '../connectors/github/client.js';
```
with:
```ts
import { getRepoHost } from '../system/backends.js';
```

- [ ] **Step 2: Replace every `getGitHubClient()` call** in this file with `getRepoHost()`. These are all the repo-tools handlers (`push_branch`, `create_pull_request`, `get_pr_status`, `get_pr_checks`, `get_check_run`, `list_code_scanning_alerts`, `get_code_scanning_alert`, `get_pr_reviews`, `get_pr_comments`, `get_review_threads`, `list_prs`, `get_pr`, `update_pr`, `add_pr_comment`, `add_review_comment`, `reply_to_review_comment`, `resolve_review_thread`, `request_re_review`, `merge_pull_request`, `close_pull_request`) plus `list_available_repos` / `spawn_repo_agent` (`client.listAccessibleRepos()` / `client.resolveRepo()`). Use a find/replace of the exact token `getGitHubClient()` → `getRepoHost()` scoped to this file, then verify the null-guard pattern (`const client = getRepoHost(); if (!client) { ...disabled... }`) still reads correctly — the variable stays named `client`, only its type widens to `RepoHost`.

Verify no other symbol from `client.js` is still needed in `tools.ts`. If `tools.ts` imported ONLY `getGitHubClient` from `client.js`, the import line is fully replaced. If it imported other names (e.g. `parseCheckRef`), keep a second import for those:

```ts
import { parseCheckRef } from '../connectors/github/client.js';
```

(Check the actual import at `tools.ts:20` and split accordingly — `parseCheckRef` is used by `get_check_run`.)

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`
Expected: PASS. A failure here means the `RepoHost` interface (Task 3) is missing a method that `tools.ts` calls — add the missing method to the interface (it exists on `GitHubClient`), re-run.

- [ ] **Step 4: Full suite.**

Run: `npm test`
Expected: PASS (baseline). If a tools test stubs `getGitHubClient`, it may now need the stub on `getRepoHost` — but per Global Constraints existing tests must pass unmodified; check whether any test mocks `client.js` for tools. If one does and now fails, the correct fix is to have `getRepoHost()` delegate (it does) so the underlying `getGitHubClient` mock still flows through. Confirm the test mocks `getGitHubClient` at the `client.js` module (it will still be called by `getRepoHost`). Do not edit the test.

- [ ] **Step 5: Commit.**

```bash
git add src/agents/tools.ts
git commit -m "refactor(tools): obtain repo host via getRepoHost() backend resolver"
```

### Task 11: Route `merge.ts` through `getRepoHost()`

**Files:**
- Modify: `src/connectors/github/merge.ts` (import at `merge.ts` top; call sites `merge.ts:64` and `merge.ts:23`)

**Interfaces:**
- Consumes: `getRepoHost()` (Task 9).
- Produces: merge orchestrator uses `RepoHost`. Behavior identical.

- [ ] **Step 1: Swap the import.** In `src/connectors/github/merge.ts`, replace the `import { createGitHubClient } from './client.js'` with:

```ts
import { getRepoHost } from '../../system/backends.js';
```

- [ ] **Step 2: Replace the two `createGitHubClient()` call sites** (`merge.ts:23` in `checkAndMergeLinkedPRs` and `merge.ts:64` in `triggerMergeCheck`) with `getRepoHost()`. The null-bail logic (`if (!githubClient) return ...`) is unchanged; the local variable stays `githubClient` (typed `RepoHost | null`). The methods used — `getPRStatus`, `mergePullRequest` — are both on `RepoHost`.

- [ ] **Step 3: Verify `fetchAllPRStatuses` param type.** Its private signature is `fetchAllPRStatuses(githubClient, linkedPRs)`. If it has an explicit `GitHubClient` type annotation, widen it to `RepoHost` and import the type:

```ts
import type { RepoHost } from '../../ports/repo-host.js';
```
Then `function fetchAllPRStatuses(githubClient: RepoHost, linkedPRs: ...)`. If the param is untyped/inferred, no change needed.

- [ ] **Step 4: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS (baseline).

- [ ] **Step 5: Commit.**

```bash
git add src/connectors/github/merge.ts
git commit -m "refactor(merge): obtain repo host via getRepoHost() backend resolver"
```

---

## Group C — Shared CR router

### Task 12: Extract host-agnostic router to `src/connectors/shared/cr-router.ts`

**Files:**
- Create: `src/connectors/shared/cr-router.ts`
- Create: `src/connectors/shared/__tests__/cr-router.test.ts`
- Modify: `src/connectors/github/webhooks.ts` (Task 13 wires it; Task 12 only extracts + characterizes)

**Interfaces:**
- Consumes: `NormalizedEventContext`, `InternalRouteAction`, `RouteResult` (Task 4); `extractTaskIdFromBranch` (`branch-naming.ts:48`); `checkAndMergeLinkedPRs` (`merge.ts:39`).
- Produces: `determineRouteAction(context: NormalizedEventContext): InternalRouteAction`, `handleMergeCheckDirect(taskId: string): void`, `handleChecksReadyDirect(taskId: string, repo: string, prNumber: number): void`, `MERGE_CHECK_DEBOUNCE_MS`, `CHECKS_READY_DEBOUNCE_MS`. Task 13 imports these into `webhooks.ts`.

> `determineRouteAction` (webhooks.ts:365), the two debounce handlers (webhooks.ts:257-337), and their timer maps are host-agnostic — they read only `NormalizedEventContext` and task ids. Move them verbatim, changing `GitHubEventContext` → `NormalizedEventContext` and the field `githubRepo` → `repo`. Keep `determineRouteAction`'s switch logic byte-identical.

- [ ] **Step 1: Read the source blocks.** Read `src/connectors/github/webhooks.ts:257-337` (debounce handlers + timer maps) and `:360-405` (`InternalRouteAction` type + `determineRouteAction` switch). Transcribe them exactly.

- [ ] **Step 2: Write the characterization test FIRST** (locks current routing behavior before the move). Create `src/connectors/shared/__tests__/cr-router.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { determineRouteAction } from '../cr-router.js';
import type { NormalizedEventContext } from '../../../ports/repo-host-events.js';

function ctx(over: Partial<NormalizedEventContext>): NormalizedEventContext {
  return { eventType: 'push', repo: 'o/r', user: 'someone', ...over };
}

describe('determineRouteAction (parity with legacy GitHub router)', () => {
  it('review approved → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request_review', action: 'submitted', state: 'approved' }))).toBe('merge_check');
  });
  it('review changes_requested → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request_review', action: 'submitted', state: 'changes_requested' }))).toBe('existing_task');
  });
  it('review comment → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request_review_comment', action: 'created' }))).toBe('existing_task');
  });
  it('issue_comment created → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'issue_comment', action: 'created' }))).toBe('existing_task');
  });
  it('issue_comment edited → noop', () => {
    expect(determineRouteAction(ctx({ eventType: 'issue_comment', action: 'edited' }))).toBe('noop');
  });
  it('pull_request closed → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request', action: 'closed' }))).toBe('existing_task');
  });
  it('pull_request opened → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request', action: 'opened' }))).toBe('merge_check');
  });
  it('pull_request synchronize → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'pull_request', action: 'synchronize' }))).toBe('merge_check');
  });
  it('push → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'push' }))).toBe('merge_check');
  });
  it('workflow_run completed+failure → existing_task', () => {
    expect(determineRouteAction(ctx({ eventType: 'workflow_run', action: 'completed', state: 'failure' }))).toBe('existing_task');
  });
  it('workflow_run completed+success → merge_check', () => {
    expect(determineRouteAction(ctx({ eventType: 'workflow_run', action: 'completed', state: 'success' }))).toBe('merge_check');
  });
  it('check_suite completed+failure → checks_ready', () => {
    expect(determineRouteAction(ctx({ eventType: 'check_suite', action: 'completed', state: 'failure' }))).toBe('checks_ready');
  });
  it('unknown event → noop', () => {
    expect(determineRouteAction(ctx({ eventType: 'ping' }))).toBe('noop');
  });
});
```

> Before writing `cr-router.ts`, cross-check each expectation against the real switch in `webhooks.ts:365` (the map summarizes it but transcribe from source). If the real switch keys `state` differently (e.g. reads `context.state` vs `context.action`), adjust the test to match REAL behavior — the test documents what IS, not what should be. Any expectation you change must reflect the transcribed source.

- [ ] **Step 3: Run test to verify it fails.**

Run: `npx vitest run src/connectors/shared/__tests__/cr-router.test.ts`
Expected: FAIL — cannot find module `../cr-router.js`.

- [ ] **Step 4: Write `src/connectors/shared/cr-router.ts`** by moving the transcribed blocks. Structure:

```ts
/**
 * Host-agnostic change-request routing (spec §3.2). Moved verbatim from
 * github/webhooks.ts: the routing decision and debounced merge/checks handling
 * depend only on NormalizedEventContext + task ids, not on raw payloads or the
 * host vendor. Per-host payload parsing + signature verification stay in each
 * connector (see RepoHostEventSource).
 */

import type { NormalizedEventContext, InternalRouteAction } from '../../ports/repo-host-events.js';
import { logger } from '../../system/logger.js';
import { checkAndMergeLinkedPRs } from '../github/merge.js';
// … plus whatever the debounce handlers reference (appendGitHubEvent, Task.get,
//   AGENT_PROMPTS) — transcribe the exact imports from webhooks.ts.

export const MERGE_CHECK_DEBOUNCE_MS = 5000;
export const CHECKS_READY_DEBOUNCE_MS = 20_000;

const mergeCheckTimers = new Map<string, NodeJS.Timeout>();
const checksReadyTimers = new Map<string, NodeJS.Timeout>();

export function determineRouteAction(context: NormalizedEventContext): InternalRouteAction {
  // … verbatim switch from webhooks.ts:365, with `context.githubRepo` → `context.repo` …
}

export function handleMergeCheckDirect(taskId: string): void {
  // … verbatim from webhooks.ts:269 …
}

export function handleChecksReadyDirect(taskId: string, repo: string, prNumber: number): void {
  // … verbatim from webhooks.ts:308, param `githubRepo` → `repo`, key `${taskId}:${repo}#${prNumber}` …
}
```

> `checkAndMergeLinkedPRs` currently lives in `github/merge.ts`. Importing it from `shared/` into `github/` is fine (shared depends on the github connector for the merge orchestrator in Phase 0; Phase 1 will inject it). If the linter flags the layering, leave a `// Phase 0: merge orchestrator still lives under github/; injected in Phase 1.` comment.

- [ ] **Step 5: Run test to verify it passes.**

Run: `npx vitest run src/connectors/shared/__tests__/cr-router.test.ts`
Expected: PASS (13 tests). If one fails, your transcription of the switch diverged — fix `cr-router.ts` to match source, not the test's guess.

- [ ] **Step 6: Typecheck (webhooks.ts still has its own copies — that's fine this task).**

Run: `npm run typecheck`
Expected: PASS. (Duplicate definitions across files are legal; Task 13 removes the originals.)

- [ ] **Step 7: Commit.**

```bash
git add src/connectors/shared/cr-router.ts src/connectors/shared/__tests__/cr-router.test.ts
git commit -m "feat(shared): extract host-agnostic cr-router with characterization tests"
```

### Task 13: Make `github/webhooks.ts` delegate routing to the shared router + conform to `RepoHostEventSource`

**Files:**
- Modify: `src/connectors/github/webhooks.ts` (remove moved code; import from shared; add a `githubEventSource` conforming to `RepoHostEventSource`)

**Interfaces:**
- Consumes: `determineRouteAction`, `handleMergeCheckDirect`, `handleChecksReadyDirect` (Task 12); `RepoHostEventSource`, `NormalizedEventContext` (Task 4).
- Produces: `webhooks.ts` re-exports the same public API it had (`routeGitHubEvent`, `handleMergeCheckDirect`, `handleChecksReadyDirect`, `formatGitHubContext`, `verifyWebhookSignature`, `formatGitHubEvent`, etc.) so `events.ts` is untouched. Adds `export const githubEventSource: RepoHostEventSource`.

- [ ] **Step 1: Delete the moved definitions** from `webhooks.ts`: `determineRouteAction` (`:365`), `InternalRouteAction` type (`:360`), `handleMergeCheckDirect` (`:269`), `handleChecksReadyDirect` (`:308`), and the two timer maps + debounce constants. Replace with an import:

```ts
import {
  determineRouteAction,
  handleMergeCheckDirect,
  handleChecksReadyDirect,
} from '../shared/cr-router.js';
import type { NormalizedEventContext } from '../../ports/repo-host-events.js';
import type { RepoHostEventSource } from '../../ports/repo-host-events.js';
```

> Keep re-exporting `handleMergeCheckDirect` / `handleChecksReadyDirect` from `webhooks.ts` if `events.ts` imports them from here (it does — `events.ts:105` dispatches to them). Add: `export { handleMergeCheckDirect, handleChecksReadyDirect } from '../shared/cr-router.js';` OR re-export via local binding. Verify `events.ts`'s import path still resolves; if `events.ts` imports these from `webhooks.js`, the re-export keeps it working with zero edits to `events.ts`.

- [ ] **Step 2: Adapt `routeGitHubEvent`** (`webhooks.ts:433`) to build a `NormalizedEventContext` and call the shared `determineRouteAction`. The existing `formatGitHubContext` returns `GitHubEventContext` whose fields are a superset with `githubRepo`; map it: `const norm: NormalizedEventContext = { ...ctx, repo: ctx.githubRepo }`. Feed `norm` to `determineRouteAction`. The `RouteResult` this function returns changes field `githubRepo` → `repo` for the `checks_ready` case — update `events.ts` dispatch accordingly ONLY IF it reads `.githubRepo` off the result (check `events.ts:105-146`; if it destructures `githubRepo`, either keep the result field named `githubRepo` in the GitHub-specific `routeGitHubEvent` return, or update the dispatcher). Prefer: keep `routeGitHubEvent`'s return shape exactly as before (GitHub-specific), so `events.ts` needs no change — only the internal `determineRouteAction` call is delegated.

- [ ] **Step 3: Add the `RepoHostEventSource` conformer.** At the end of `webhooks.ts`:

```ts
/**
 * GitHub's RepoHostEventSource — wraps the existing verify/parse/self-event
 * functions so backends.ts can hand callers a host-neutral event source.
 */
export const githubEventSource: RepoHostEventSource = {
  kind: 'github',
  verifySignature(rawBody, headers, secret) {
    const sig = headers['x-hub-signature-256'];
    return typeof sig === 'string' && verifyWebhookSignature(rawBody, sig, secret);
  },
  parseEvent(eventType, payload) {
    const ctx = formatGitHubContext(eventType, payload as any);
    return { ...ctx, repo: ctx.githubRepo };
  },
  isSelfEvent(context) {
    return context.user === getGitHubAppBotUsername();
  },
};
```

> `getGitHubAppBotUsername` is module-private (`webhooks.ts:420`). It is already in this file, so the conformer can call it directly. `verifyWebhookSignature` and `formatGitHubContext` are exported from this file.

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`
Expected: PASS. Resolve any `githubRepo` vs `repo` mismatch per Step 2's guidance (keep the external `routeGitHubEvent`/`RouteResult` shape stable to avoid touching `events.ts`).

- [ ] **Step 5: Full suite (includes the branch-naming test and the new cr-router test).**

Run: `npm test`
Expected: PASS (baseline + 13 from Task 12).

- [ ] **Step 6: Commit.**

```bash
git add src/connectors/github/webhooks.ts src/connectors/github/events.ts
git commit -m "refactor(github): delegate routing to shared cr-router; add RepoHostEventSource conformer"
```

---

## Group D — Claude SDK barrel + AgentRuntime

### Task 14: Consolidate all Claude-SDK imports behind `src/runtime/claude/sdk.ts`

**Files:**
- Create: `src/runtime/claude/sdk.ts`
- Modify: `src/agents/spawn.ts:16`, `src/agents/tools.ts:14`, `src/agents/mcp-file-bridge.ts:25`, `src/agents/sandbox.ts:13`, `src/mcp/research-tools.ts:17-18`

**Interfaces:**
- Produces: `src/runtime/claude/sdk.ts` re-exporting `query`, `tool`, `createSdkMcpServer` (values) and `HookCallbackMatcher`, `HookJSONOutput` (types) from `@anthropic-ai/claude-agent-sdk`. After this task the isolation grep passes for every file EXCEPT the four one-shot sites (removed in Group E) — those still import `query` directly until migrated.

> This task funnels the imports of the files that will KEEP using the SDK (spawn, tools, mcp-file-bridge, sandbox, research-tools). The four one-shot sites (title/extractor/housekeeping/triage) are handled in Group E, where they stop importing the SDK entirely (they call `LlmOneShot`). The `LlmOneShot` impl (Task 17) also imports from this barrel.

- [ ] **Step 1: Write `src/runtime/claude/sdk.ts`.**

```ts
/**
 * The ONE place `@anthropic-ai/claude-agent-sdk` is imported (spec P4/R4:
 * confine vendor imports to the runtime module). Every other file imports SDK
 * symbols from here so the isolation grep stays green and a future SDK swap or
 * version pin touches a single file.
 */

export { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
export type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
```

> If typecheck reports additional value/type names those five files import from the SDK (beyond the ones the map found), add them to this barrel's export lists. Re-run typecheck until clean.

- [ ] **Step 2: Repoint the five importers.** Change each import specifier from `'@anthropic-ai/claude-agent-sdk'` to the barrel (use the correct relative depth):
  - `src/agents/spawn.ts:16` `import { query } from '../runtime/claude/sdk.js';`
  - `src/agents/tools.ts:14` `import { tool, createSdkMcpServer } from '../runtime/claude/sdk.js';`
  - `src/agents/mcp-file-bridge.ts:25` `import { tool, createSdkMcpServer } from '../runtime/claude/sdk.js';`
  - `src/agents/sandbox.ts:13` `import type { HookCallbackMatcher, HookJSONOutput } from '../runtime/claude/sdk.js';`
  - `src/mcp/research-tools.ts:17` `import { query, tool, createSdkMcpServer } from '../runtime/claude/sdk.js';` and `:18` `import type { HookCallbackMatcher, HookJSONOutput } from '../runtime/claude/sdk.js';`

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Full suite.**

Run: `npm test`
Expected: PASS (baseline). Note: `title-generator.test.ts:21` mocks `@anthropic-ai/claude-agent-sdk` directly — that file still imports the SDK at this point (migrated in Task 18), so the mock still resolves. Do not touch it here.

- [ ] **Step 5: Partial isolation check (informational).**

Run: `grep -rn "claude-agent-sdk" src --include="*.ts" | grep -v "runtime/claude"`
Expected: only the four one-shot sites remain (`title-generator.ts`, `extractor.ts`, `housekeeping.ts`, `triage.ts`) plus the test mock. Group E clears the four sites.

- [ ] **Step 6: Commit.**

```bash
git add src/runtime/claude/sdk.ts src/agents/spawn.ts src/agents/tools.ts src/agents/mcp-file-bridge.ts src/agents/sandbox.ts src/mcp/research-tools.ts
git commit -m "refactor(runtime): funnel Claude SDK imports through runtime/claude/sdk barrel"
```

### Task 15: `ClaudeSdkRuntime` + rewire `agent.ts`

**Files:**
- Create: `src/runtime/claude/runtime.ts`
- Modify: `src/agents/agent.ts:13` (import), `agent.ts:156` (spawn call)
- Modify: `src/system/backends.ts` (add `getAgentRuntime()`)

**Interfaces:**
- Consumes: `AgentRuntime`, `RuntimeCapabilities`, `CLAUDE_RUNTIME_CAPABILITIES`; `spawnAgent` (`spawn.ts:195`).
- Produces: `class ClaudeSdkRuntime implements AgentRuntime`, `export const claudeSdkRuntime`. `getAgentRuntime(): AgentRuntime`. `agent.ts` calls `getAgentRuntime().spawn(this, task)`.

- [ ] **Step 1: Write `src/runtime/claude/runtime.ts`.**

```ts
/**
 * ClaudeSdkRuntime — the AgentRuntime backed by the Claude Agent SDK. Phase 0
 * delegates straight to the existing spawnAgent(); the SDK event-loop, hooks,
 * sandbox, and session recovery all stay in spawn.ts. Phase 2 adds OpencodeRuntime
 * alongside this and normalizes the AgentSpawnSpec/RuntimeEvent model.
 */

import type { AgentRuntime } from '../../ports/agent-runtime.js';
import type { RuntimeCapabilities } from '../../ports/capabilities.js';
import { CLAUDE_RUNTIME_CAPABILITIES } from '../../ports/capabilities.js';
import type { Agent } from '../../agents/agent.js';
import type { Task } from '../../tasks/task.js';
import { spawnAgent } from '../../agents/spawn.js';

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly kind = 'claude' as const;

  capabilities(): RuntimeCapabilities {
    return CLAUDE_RUNTIME_CAPABILITIES;
  }

  async spawn(agent: Agent, task: Task): Promise<void> {
    await spawnAgent(agent, task);
  }
}

export const claudeSdkRuntime = new ClaudeSdkRuntime();
```

> Watch the import cycle: `agent.ts` → `runtime/claude/runtime.ts` → `spawn.ts` → `agent.ts`. `agent.ts` already breaks this today via a dynamic import comment (`agent.ts:127`) but statically imports `spawnAgent` at `:13`. To stay safe, `agent.ts` should import the runtime lazily inside `spawn()` (dynamic import), mirroring the existing pattern. See Step 3.

- [ ] **Step 2: Add `getAgentRuntime()` to `src/system/backends.ts`.** Append:

```ts
import type { AgentRuntime } from '../ports/agent-runtime.js';
import { claudeSdkRuntime } from '../runtime/claude/runtime.js';

export function getAgentRuntime(): AgentRuntime {
  const runtime = resolveAgentRuntimeKind();
  switch (runtime) {
    case 'claude':
      return claudeSdkRuntime;
    default:
      // Rejected by assertBackendConfig() at boot; default defensively.
      logger.warn('backends', `getAgentRuntime() called for unsupported runtime "${runtime}"; defaulting to claude`);
      return claudeSdkRuntime;
  }
}
```

> If a static `import { claudeSdkRuntime }` in backends.ts creates a cycle (backends → runtime → spawn → tools → backends, since Task 10 made tools import backends), convert this to a lazy import inside `getAgentRuntime()`:
> ```ts
> export async function getAgentRuntime(): Promise<AgentRuntime> { const { claudeSdkRuntime } = await import('../runtime/claude/runtime.js'); ... }
> ```
> Prefer the static import; only go async if typecheck/runtime shows a cycle. If you make it async, update the `agent.ts` call site (Step 3) to `await`.

- [ ] **Step 3: Rewire `agent.ts`.** Replace the static `import { spawnAgent } from './spawn.js';` (`agent.ts:13`) — remove it — and change the spawn call (`agent.ts:156`) from `await spawnAgent(this, task);` to a lazily-imported runtime call, preserving the surrounding try/catch:

```ts
try {
  const { getAgentRuntime } = await import('../system/backends.js');
  await getAgentRuntime().spawn(this, task);
} catch (err) {
  task.updateAgentState(this.def.id, false);
  throw err;
}
```

(If Step 2 made `getAgentRuntime` async, use `await (await getAgentRuntime()).spawn(...)`.) The dynamic import matches the file's existing cycle-avoidance note at `agent.ts:127`.

- [ ] **Step 4: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS (baseline). Agent spawn is exercised by recovery/spawn tests in `src/agents/__tests__` and `src/tasks/__tests__` — they must stay green, proving the indirection is behavior-preserving.

- [ ] **Step 5: Commit.**

```bash
git add src/runtime/claude/runtime.ts src/system/backends.ts src/agents/agent.ts
git commit -m "feat(runtime): add ClaudeSdkRuntime and route agent spawn through getAgentRuntime()"
```

---

## Group E — LlmOneShot + migrate one-shot sites

### Task 16: `ClaudeLlmOneShot` implementation

**Files:**
- Create: `src/runtime/claude/llm-one-shot.ts`
- Modify: `src/system/backends.ts` (add `getLlmOneShot()`)

**Interfaces:**
- Consumes: `LlmOneShot`, `LlmTextRequest`, `LlmJsonRequest` (Task 6); `query` (Task 14 barrel).
- Produces: `class ClaudeLlmOneShot implements LlmOneShot`, `export const claudeLlmOneShot`, `getLlmOneShot(): LlmOneShot`. Tasks 18–21 call `getLlmOneShot()`.

> The `text()` accumulation must replicate extractor/housekeeping exactly: accumulate `text` blocks from `assistant` events, then override with the `result` string on a `success` result. `json()` must replicate title/triage: on `result`+`success` return `event.structured_output` (raw), else null. Env allowlist replicates the sites: `{ NODE_ENV, ANTHROPIC_API_KEY, PATH }`, plus `cwd` and `allowedTools` when supplied.

- [ ] **Step 1: Write a test for the env/plumbing shape** (mock the barrel). Create `src/runtime/claude/__tests__/llm-one-shot.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../sdk.js', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { claudeLlmOneShot } from '../llm-one-shot.js';

function stream(events: unknown[]) {
  return (async function* () { for (const e of events) yield e; })();
}

beforeEach(() => { queryMock.mockReset(); process.env.ANTHROPIC_API_KEY = 'k'; });

describe('ClaudeLlmOneShot', () => {
  it('text() returns the result string on success', async () => {
    queryMock.mockReturnValue(stream([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
      { type: 'result', subtype: 'success', result: 'final text' },
    ]));
    const out = await claudeLlmOneShot.text({ prompt: 'hi', model: 'sonnet' });
    expect(out).toBe('final text');
  });

  it('json() returns raw structured_output on success', async () => {
    queryMock.mockReturnValue(stream([
      { type: 'result', subtype: 'success', structured_output: { title: 'X' } },
    ]));
    const out = await claudeLlmOneShot.json({ prompt: 'hi', model: 'haiku', jsonSchema: {} });
    expect(out).toEqual({ title: 'X' });
  });

  it('json() returns null on a non-success result', async () => {
    queryMock.mockReturnValue(stream([{ type: 'result', subtype: 'error_max_turns' }]));
    const out = await claudeLlmOneShot.json({ prompt: 'hi', model: 'haiku', jsonSchema: {} });
    expect(out).toBeNull();
  });

  it('passes model, systemPrompt, allowedTools, cwd through to query options', async () => {
    queryMock.mockReturnValue(stream([{ type: 'result', subtype: 'success', result: 'ok' }]));
    await claudeLlmOneShot.text({ prompt: 'p', model: 'haiku', systemPrompt: 'sys', allowedTools: ['Read'], cwd: '/tmp/x' });
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.model).toBe('haiku');
    expect(opts.systemPrompt).toBe('sys');
    expect(opts.allowedTools).toEqual(['Read']);
    expect(opts.cwd).toBe('/tmp/x');
    expect(opts.env.ANTHROPIC_API_KEY).toBe('k');
  });
});
```

> The `assistant` event content shape above (`message.content[]`) is a guess — before writing the impl, transcribe the REAL accumulation from `extractor.ts:255-270` (the map says it reads `text` blocks from `event.type==='assistant'` then overrides with `(event as any).result`). Match the test's `assistant` event shape to whatever the real extractor reads, so the impl and test agree with production.

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/runtime/claude/__tests__/llm-one-shot.test.ts`
Expected: FAIL — cannot find module `../llm-one-shot.js`.

- [ ] **Step 3: Write `src/runtime/claude/llm-one-shot.ts`.** Transcribe the exact event handling from `title-generator.ts:97-127` (json) and `extractor.ts:234-270` (text).

```ts
/**
 * ClaudeLlmOneShot — one-shot LLM calls via the Claude Agent SDK query() (spec
 * §3.4). Consolidates the env allowlist + event-loop plumbing that title
 * generation, memory extraction/housekeeping, and triage each hand-rolled.
 * Callers keep their own schema construction + downstream validation, so
 * behavior is identical to the pre-consolidation call sites.
 */

import type { LlmOneShot, LlmTextRequest, LlmJsonRequest } from '../../ports/llm-one-shot.js';
import { query } from './sdk.js';

function baseEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: process.env.NODE_ENV || 'development',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    PATH: process.env.PATH,
  };
}

function baseOptions(req: LlmTextRequest): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    model: req.model,
    executable: 'node',
    env: baseEnv(),
    maxTurns: req.maxTurns ?? 2,
    tools: [],
  };
  if (req.systemPrompt !== undefined) opts.systemPrompt = req.systemPrompt;
  if (req.allowedTools !== undefined) { opts.allowedTools = req.allowedTools; delete opts.tools; }
  if (req.cwd !== undefined) opts.cwd = req.cwd;
  if (req.stderr !== undefined) opts.stderr = req.stderr;
  return opts;
}

export class ClaudeLlmOneShot implements LlmOneShot {
  readonly kind = 'claude' as const;

  async text(req: LlmTextRequest): Promise<string | null> {
    let acc = '';
    let resultText: string | null = null;
    for await (const event of query({ prompt: req.prompt, options: baseOptions(req) as any })) {
      if ((event as any).type === 'assistant') {
        // Transcribe the exact block-walk from extractor.ts:255-264.
        for (const block of (event as any).message?.content ?? []) {
          if (block?.type === 'text') acc += block.text;
        }
      } else if ((event as any).type === 'result') {
        if ((event as any).subtype === 'success') resultText = (event as any).result ?? acc;
      }
    }
    return resultText ?? (acc || null);
  }

  async json(req: LlmJsonRequest): Promise<unknown | null> {
    const options = baseOptions(req) as any;
    options.outputFormat = { type: 'json_schema', schema: req.jsonSchema };
    for await (const event of query({ prompt: req.prompt, options })) {
      if ((event as any).type !== 'result') continue;
      if ((event as any).subtype === 'success') return (event as any).structured_output ?? null;
      return null;
    }
    return null;
  }
}

export const claudeLlmOneShot = new ClaudeLlmOneShot();
```

> IMPORTANT: reconcile the `text()` accumulation with the real extractor before finalizing — if the extractor uses a different accumulation/override precedence, match it precisely (production parity beats the sketch above). Same for `json()` vs title-generator.

- [ ] **Step 4: Add `getLlmOneShot()` to `backends.ts`.**

```ts
import type { LlmOneShot } from '../ports/llm-one-shot.js';
import { claudeLlmOneShot } from '../runtime/claude/llm-one-shot.js';

export function getLlmOneShot(): LlmOneShot {
  // Tied to the agent runtime selection (both are LLM-provider bindings).
  return claudeLlmOneShot;
}
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npx vitest run src/runtime/claude/__tests__/llm-one-shot.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/runtime/claude/llm-one-shot.ts src/runtime/claude/__tests__/llm-one-shot.test.ts src/system/backends.ts
git commit -m "feat(runtime): add ClaudeLlmOneShot and getLlmOneShot() resolver"
```

### Task 17: Migrate `title-generator.ts` to `LlmOneShot.json`

**Files:**
- Modify: `src/tasks/title-generator.ts`
- Modify: `src/tasks/__tests__/title-generator.test.ts` — see note (this is the ONE test that mocks the SDK; it must keep passing, ideally unmodified)

**Interfaces:**
- Consumes: `getLlmOneShot()` (Task 16).
- Produces: `title-generator.ts` no longer imports `@anthropic-ai/claude-agent-sdk`.

> Behavior contract to preserve exactly: build `titleJsonSchema` the same way (zod `toJSONSchema`, strip `$schema`), call the one-shot with `model:'haiku'`, `systemPrompt: SYSTEM_PROMPT`, `maxTurns:2`, and `TitleSchema.safeParse` the returned structured output. Return `cleanTitle(result.title)` or null.

- [ ] **Step 1: Check the existing test's mock.** Read `src/tasks/__tests__/title-generator.test.ts:21,61`. It mocks `@anthropic-ai/claude-agent-sdk`'s `query`. After migration, `title-generator.ts` imports `getLlmOneShot` (which internally uses the barrel-wrapped `query`). Decide the minimal-friction path:
  - **Preferred (no test edit):** if the test mocks the module `@anthropic-ai/claude-agent-sdk`, that mock will NOT intercept the barrel (`runtime/claude/sdk.js` re-exports it, but Vitest module mocks are by specifier). So the test WOULD break. Per Global Constraints we avoid editing tests — but this test asserts against an implementation detail (the SDK) that is legitimately changing. This is the sanctioned exception: update the mock target from `@anthropic-ai/claude-agent-sdk` to `../../system/backends.js` (mock `getLlmOneShot` to return a stub whose `json()` yields the fixture). Document in the commit why this test changed.

- [ ] **Step 2: Rewrite the call site.** Replace the import and the `for await (query(...))` block:

```ts
// remove: import { query } from '@anthropic-ai/claude-agent-sdk';
import { getLlmOneShot } from '../system/backends.js';
```
and inside `generateTaskTitle`, replace the loop (`title-generator.ts:97-127`) with:

```ts
const raw = await getLlmOneShot().json({
  prompt,
  model: 'haiku',
  systemPrompt: SYSTEM_PROMPT,
  maxTurns: 2,
  jsonSchema: titleJsonSchema,
});
if (!raw) return null;
const parsed = TitleSchema.safeParse(raw);
if (!parsed.success) {
  logger.warn('title-generator', `schema validation failed: ${parsed.error.message}`);
  return null;
}
result = parsed.data;
```

- [ ] **Step 3: Update the test mock** per Step 1 (mock `../../system/backends.js`'s `getLlmOneShot` to return `{ json: async () => fixture, text: async () => null, kind: 'claude' }`; adapt the two existing test cases to drive `json()`'s return instead of a `query` event stream). Keep the assertions (returned title string / null) identical.

- [ ] **Step 4: Typecheck + this test.**

Run: `npm run typecheck && npx vitest run src/tasks/__tests__/title-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/tasks/title-generator.ts src/tasks/__tests__/title-generator.test.ts
git commit -m "refactor(title): use LlmOneShot.json instead of direct SDK query"
```

### Task 18: Migrate `memory/extractor.ts` to `LlmOneShot.text`

**Files:**
- Modify: `src/memory/extractor.ts:8,234-270`

**Interfaces:**
- Consumes: `getLlmOneShot()`.
- Produces: `extractor.ts` no longer imports the SDK; `runExtraction` behavior identical (same prompt, `model:'sonnet'`, `maxTurns:1`, `stderr` debug, then `parseExtractionResponse`).

- [ ] **Step 1: Read `extractor.ts:230-272`** and transcribe the exact response-accumulation so the `text()` call reproduces `responseText`.

- [ ] **Step 2: Rewrite the call site.**

```ts
// remove: import { query } from '@anthropic-ai/claude-agent-sdk';
import { getLlmOneShot } from '../system/backends.js';
```
Replace the `query(...)` loop with:
```ts
const responseText = await getLlmOneShot().text({
  prompt,
  model: 'sonnet',
  maxTurns: 1,
  stderr: (data) => logger.debug('memory-extractor', data),
});
if (responseText === null) return null;
```
(Match the `stderr` callback to whatever the current code does — the map notes a `stderr` debug callback; transcribe it verbatim.) Then keep `parseExtractionResponse(responseText, allowedUserIds)` exactly as-is.

- [ ] **Step 3: Typecheck + memory tests.**

Run: `npm run typecheck && npx vitest run src/memory/__tests__`
Expected: PASS. If a memory test mocks the SDK `query`, apply the same sanctioned mock-retarget as Task 17 (mock `getLlmOneShot`), keeping assertions identical.

- [ ] **Step 4: Full suite.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/memory/extractor.ts
git commit -m "refactor(memory): extractor uses LlmOneShot.text instead of direct SDK query"
```

### Task 19: Migrate `memory/housekeeping.ts` to `LlmOneShot.text`

**Files:**
- Modify: `src/memory/housekeeping.ts:16,248-298`

**Interfaces:**
- Consumes: `getLlmOneShot()`.
- Produces: `housekeeping.ts` no longer imports the SDK; `runHousekeeperAgent` returns the same trimmed string.

- [ ] **Step 1: Read `housekeeping.ts:248-298`** and transcribe the accumulation.

- [ ] **Step 2: Rewrite the call site** (mirror Task 18): replace the SDK import with `getLlmOneShot`, replace the `query(...)` loop with:

```ts
const responseText = await getLlmOneShot().text({
  prompt,
  model: 'sonnet',
  maxTurns: 1,
  stderr: (data) => logger.debug('memory-housekeeper', data),
});
return (responseText ?? '').trim();
```
(Match the exact return/trim behavior at `housekeeping.ts:298` and the `stderr` label used today.)

- [ ] **Step 3: Typecheck + memory tests + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS. Apply the sanctioned mock-retarget if a housekeeping test mocks the SDK.

- [ ] **Step 4: Commit.**

```bash
git add src/memory/housekeeping.ts
git commit -m "refactor(memory): housekeeping uses LlmOneShot.text instead of direct SDK query"
```

### Task 20: Migrate `system/triage.ts` to `LlmOneShot.json`

**Files:**
- Modify: `src/system/triage.ts:8,37-110`

**Interfaces:**
- Consumes: `getLlmOneShot()`.
- Produces: `triage.ts` no longer imports the SDK. (Triage is disabled; still must typecheck + keep any triage test green.)

> Triage builds its JSON schema with `zod-to-json-schema` (`$refStrategy:'none'`) and allows `['Glob','Grep','Read']` with `cwd: sessionsDir`. Preserve ALL of this: keep the `zodToJsonSchema` build at the call site, pass `jsonSchema`, `allowedTools`, `cwd` through the request. Keep the `safeParse` + fallback default logic exactly.

- [ ] **Step 1: Read `triage.ts:37-110`** and transcribe the option bag + result handling (including the `error_max_structured_output_retries` / `error_during_execution` handling and the fallback default).

- [ ] **Step 2: Rewrite `runTriage`'s call.** Replace the SDK import with `getLlmOneShot`; build `jsonSchema` as today (`zodToJsonSchema(schema, {$refStrategy:'none'})`), then:

```ts
const raw = await getLlmOneShot().json({
  prompt: input,
  model: 'haiku',
  systemPrompt: loadPrompt('triage-agent', {}),
  cwd: sessionsDir,
  allowedTools: ['Glob', 'Grep', 'Read'],
  jsonSchema,
});
const parsed = raw === null ? null : schema.safeParse(raw);
if (!parsed || !parsed.success) {
  // keep the exact fallback default the current code returns
  return schema.parse({ action: 'noop', confidence: 'low', reasoning: 'Default fallback' });
}
return parsed.data;
```

> The current code distinguishes several failure subtypes for logging. Since `json()` collapses non-success to `null`, keep behavior equivalent: a `null` return maps to the same fallback the subtypes produced. If any triage test asserts on a specific subtype log line, that detail is lost — verify no such test exists (map found no triage-specific test). If one does, retarget it like Task 17.

- [ ] **Step 3: Typecheck + system tests + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Isolation gate — the big one.**

Run: `grep -rn "claude-agent-sdk" src --include="*.ts" | grep -v "runtime/claude"`
Expected: EMPTY. (All four one-shot sites migrated; spawn/tools/mcp-file-bridge/sandbox/research-tools import from the barrel.) If `title-generator.test.ts` still matches, it's the test mock — that's acceptable per Task 17's retarget (it should now mock `backends.js`, not the SDK; if you left the SDK mock, retarget it now).

- [ ] **Step 5: Commit.**

```bash
git add src/system/triage.ts
git commit -m "refactor(triage): use LlmOneShot.json instead of direct SDK query"
```

---

## Group F — Boot wiring, docs, final acceptance

### Task 21: Wire `assertBackendConfig()` + matrix logging into boot and `/health`

**Files:**
- Modify: `src/index.ts` (`loadConfig`/`main` — add validation near `index.ts:93`; `/health` at `index.ts:212`)

**Interfaces:**
- Consumes: `assertBackendConfig`, `getBackendMatrix` (Task 9).

- [ ] **Step 1: Import in `index.ts`.**

```ts
import { assertBackendConfig, getBackendMatrix } from './system/backends.js';
```

- [ ] **Step 2: Validate + log at boot.** Right after `const config = loadConfig();` (`index.ts:93`):

```ts
assertBackendConfig();
const matrix = getBackendMatrix();
logger.system(`Backends: repoHost=${matrix.repoHost} runtime=${matrix.runtime}`);
```

(Placing it after `loadConfig()` keeps the existing `ANTHROPIC_API_KEY` check first; `assertBackendConfig` throwing here is caught by `main`'s try/catch → `process.exit(1)` with the actionable message.)

- [ ] **Step 3: Surface in `/health`.** Extend the health payload (`index.ts:214`):

```ts
res.status(shutting ? 503 : 200).json({
  status: shutting ? 'shutting_down' : 'ok',
  activeTasks: getActiveTaskIds().length,
  backends: getBackendMatrix(),
});
```

- [ ] **Step 4: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Boot smoke (default config).**

Run: `npm run build` then confirm `node dist/index.js` logs `Backends: repoHost=github runtime=claude` early in startup (it will later fail/exit only if unrelated env like Slack is required — the backend line must appear before that). Alternatively `npm run dev` and observe the log line. Capture the line as evidence.

- [ ] **Step 6: Commit.**

```bash
git add src/index.ts
git commit -m "feat(boot): validate + log resolved backend matrix; expose in /health"
```

### Task 22: Architecture doc + CLAUDE.md pointer

**Files:**
- Create: `docs/architecture/backends.md`
- Modify: `CLAUDE.md` (Architecture Overview section — add a one-line pointer)

**Interfaces:** none (docs).

- [ ] **Step 1: Write `docs/architecture/backends.md`** describing: the two seams + one resolver diagram (copy the spec §3 ASCII), the `src/ports/` interfaces, `src/system/backends.ts` resolution + env vars (`REPO_HOST`, `AGENT_RUNTIME` — defaults, Phase-0 supported values), the `runtime/claude/` barrel + isolation rule, and the capability descriptors. State clearly: Phase 0 supports only `github`/`claude`; GitLab is Phase 1, opencode Phase 2. One line per paragraph (no hard wrap).

- [ ] **Step 2: Add a pointer in `CLAUDE.md`** under "Architecture Overview": a single line — `- Backend seams (repo host / agent runtime) are abstracted behind src/ports/ and resolved by src/system/backends.ts; see docs/architecture/backends.md.`

- [ ] **Step 3: Commit.**

```bash
git add docs/architecture/backends.md CLAUDE.md
git commit -m "docs(architecture): document the backend abstraction seams"
```

### Task 23: Final acceptance gate

**Files:** none (verification only).

- [ ] **Step 1: Vendor-isolation greps (spec acceptance).**

Run: `grep -rn "@octokit" src --include="*.ts" | grep -v "connectors/github"` → Expected: EMPTY.
Run: `grep -rn "claude-agent-sdk" src --include="*.ts" | grep -v "runtime/claude"` → Expected: EMPTY (a `title-generator.test.ts` hit is allowed only if it mocks `backends.js`, not the SDK; if it still names the SDK, fix per Task 17).

- [ ] **Step 2: Full suite + typecheck + build.**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS; test count = baseline + tasks-added new tests, with ZERO baseline tests modified except the sanctioned `title-generator.test.ts` (and any memory/triage test that mocked the SDK) mock retargets.

- [ ] **Step 3: Diff audit for unmodified existing tests.**

Run: `git diff --stat <phase-0-start-sha>..HEAD -- '**/__tests__/**'`
Expected: only NEW test files, plus the sanctioned SDK-mock retargets. If any other existing test file changed, investigate — a behavior change leaked.

- [ ] **Step 4: Manual smoke (default config) — document, don't automate here.** Per spec acceptance: Slack task → RO investigation → edit mode → PR → auto-merge, identical to pre-refactor. Use the `archie-e2e` skill/harness (the repo has one) to drive the basic + edit-mode scenarios against this branch and capture evidence. Record pass/fail with the evidence file paths in the PR description.

- [ ] **Step 5: Final commit (if any doc/evidence notes) + summary.** Summarize in the PR body: seams extracted, isolation greps green, test delta, smoke evidence.

---

## Self-Review (run by the plan author before execution)

**Spec coverage (Phase 0 scope §5):**
- "Define RepoHost, RepoHostEventSource, AgentRuntime, LlmOneShot, capability types in src/ports/" → Tasks 1–7. ✓
- "Make GitHubHost a conformance wrapper over GitHubClient; route tools.ts + merge.ts through the interface" → Tasks 8, 10, 11. ✓
- "Move host-agnostic webhook routing into src/connectors/shared/cr-router.ts" → Tasks 12–13. ✓
- "Make ClaudeSdkRuntime wrap spawn.ts behind AgentRuntime; change call surface in Task/agent.ts" → Tasks 14–15. ✓
- "Add backends.ts config resolver (one option per seam)" → Tasks 9, 15, 16. ✓
- "LlmOneShot warm-up (title/memory)" → Tasks 16–20 (incl. triage). ✓
- Acceptance greps → Task 23. ✓ Test suite unmodified → Global Constraints + Task 23 Step 3. ✓ Manual smoke → Task 23 Step 4. ✓

**Known open items surfaced by grounding (decide during execution, not blockers):**
- The 5th direct `query()` site — `src/mcp/research-tools.ts:76` — is a research sub-agent, not a plain one-shot; Phase 0 leaves its logic intact and only repoints its import to the barrel (Task 14). It is NOT migrated to LlmOneShot. This satisfies the isolation grep. Flagged so no one "cleans it up" into LlmOneShot mid-Phase-0.
- `title-generator.test.ts` (and possibly a memory/triage test) mock the SDK. Editing them is the one sanctioned test change (Task 17/18/19/20 notes) — they assert an implementation detail that is legitimately moving.

**Placeholder scan:** New files (`repo-host-types`, `capabilities`, `repo-host`, `repo-host-events`, `agent-runtime`, `llm-one-shot`, `backends`, `sdk`, `runtime`, `llm-one-shot` impl) have complete code. Edit tasks reference exact file:line anchors from the codebase map. The two intentional `// … verbatim …` markers (Task 1 Step 2, Task 12 Step 4) require transcription from named source line ranges — this is deliberate (transcribe-don't-invent) to guarantee byte-parity, with the exact source lines given.

**Type consistency:** `getRepoHost(): RepoHost | null` used in Tasks 9/10/11. `RepoHost` methods (`getPRStatus`, `mergePullRequest`, `listCodeScanningAlerts`, …) match `GitHubClient`'s real signatures from the map. `getAgentRuntime()` / `getLlmOneShot()` return the port types. `NormalizedEventContext.repo` (not `githubRepo`) consistent across Tasks 4/12/13.

