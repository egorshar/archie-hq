---
name: upstream-audit
description: Audit an incoming upstream range for changes that need follow-up work in this fork's GitLab repo-host adapter or opencode agent runtime. Scans the delta with tripwire rules, triages each hit against the fork-side counterpart, and writes a verdict report. Use before or after merging upstream/main, or when asked to "check what upstream breaks", "audit the upstream delta", or "sync from upstream".
---

# upstream-audit — what does upstream break in our seams?

This fork carries two seams upstream does not have: a **RepoHost port** with a GitLab adapter, and an **AgentRuntime port** with an opencode runtime. Upstream writes GitHub-only and SDK-only code freely — it has no reason not to. Every sync therefore lands code that either bypasses a port or changes behaviour one adapter implements and the other does not.

The audit is two layers. A scanner produces the candidate set mechanically — cheap and complete. You triage each candidate — that part cannot be automated, because the rules are structural and the question is semantic.

## Prerequisites

- An `upstream` remote pointing at `sweatco/archie-hq`, fetched: `git fetch upstream`.
- Run from the fork trunk (`integration`) or any branch carrying both seams. On a branch without `src/ports/`, the audit is meaningless.

## Lifecycle

### 1. Scan

```bash
npx tsx tools/upstream-audit/audit.ts --out docs/upstream-audit/$(date +%Y-%m-%d)-$(git rev-parse --short upstream/main).md
```

With no range argument it audits `$(git merge-base upstream/main HEAD)..upstream/main` — exactly what the next merge would bring. Pass an explicit range to audit after the fact (`--json` gives the raw hits instead of the report).

Read the report's **Seam invariants** section first. It checks the working tree, not the delta: zero occurrences of the Claude Agent SDK outside `src/runtime/claude/`, zero of octokit outside `src/connectors/github/`. Both hold on this fork today. A violation means a seam has already leaked, and that outranks anything in the delta — fix it before triaging.

### 2. Triage

For each row, fill the empty Verdict cell. Per hit:

1. Read what upstream actually did: `git diff <range> -- <file>`.
2. Read the fork-side counterparts named in the row's **Look at** column.
3. Decide `needs-work`, `no-op`, or `unsure`, and name the fork file to change.

What each verdict means:

- **`needs-work`** — the fork must change, and you name where. Example: upstream adds `getGitHubClient()` in `src/agents/tools.ts` to fetch check runs. On GitLab that returns nothing. The fix is a method on `RepoHost`, an implementation in the GitLab adapter, and the call site routed through `getRepoHost()`.
- **`no-op`** — the change genuinely does not cross the seam. Example: `src/connectors/github/client.ts` changed only its retry backoff. GitLab has its own HTTP layer in `src/connectors/gitlab/http.ts` and is unaffected.
- **`unsure`** — you cannot tell without running it. Say what you would need to know. Do not guess a verdict to close the row.

Judgment per pack:

- **GitLab**: ask "would this code path do the right thing when `REPO_HOST=gitlab`?" A GitHub-only API call, a GitHub-shaped id, a GitHub webhook field, a `GITHUB_*` env key with no counterpart — all `needs-work`. Host-agnostic helpers (`branch-naming`, `branch-state`, `repo-clone`) are shared as-is; changes there are usually `no-op` for the adapter.
- **opencode**: ask "would an agent on `AGENT_RUNTIME=opencode` still get this?" A new tool, a new sandbox rule, a new hook, a new frontmatter key, a new prompt variable — the opencode runtime mirrors each by hand, so each is `needs-work` until you have checked the mirror. A new `query()` call site is `needs-work` on `getLlmOneShot()`, not on the runtime.

Skip rows a previous report in `docs/upstream-audit/` already settled for the same rule and file, unless upstream touched that file again since. Say in the summary how many rows you carried over.

### 3. Report

Write the filled table back to the same file. Then summarize in chat: the count per verdict, and the `needs-work` rows as a plain to-do list with fork-side file per item.

Do not commit the report — `CLAUDE.md` reserves commits for explicit requests.

### 4. Hand off

The audit ends at the checklist. It does not merge, and it does not fix. Merging upstream and implementing the follow-ups are separate, explicitly-requested steps.

## Rules

| Rule | Pack | Fires on |
| --- | --- | --- |
| `repo-host-leak` | gitlab | Added `getGitHubClient` outside the GitHub connector and `backends.ts` |
| `octokit-surface` | gitlab | Added raw `octokit` / `@octokit/` outside the GitHub connector |
| `github-connector-drift` | gitlab | Change to `client.ts`, `merge.ts`, `mergeability.ts`, `pr-attribution.ts` |
| `webhook-drift` | gitlab | Change to `events.ts` or `webhooks.ts` |
| `github-env` | gitlab | New `GITHUB_*` key in `.env.example` |
| `sdk-leak` | opencode | Added `@anthropic-ai/claude-agent-sdk` import outside `src/runtime/claude/` |
| `agent-surface-drift` | opencode | Change to `agent`, `spawn`, `sandbox`, `registry`, `prompts`, `core-skills`, `tool-approval-gate`, `mcp-file-bridge` |
| `tool-registry-drift` | opencode | Newly registered agent tool in `src/agents/tools.ts` |

Test files are suppressed throughout: they mock the seam rather than crossing it, and the production change they cover is caught on its own.

Rules live in `tools/upstream-audit/rules.ts`. Adding one is a rule object plus a test in `rules.test.ts` — the natural way to extend the audit to another fork-only feature.

## What this does not catch

The rules are structural. Upstream can break GitLab or opencode purely semantically — change the PR body format that `status-map.ts` parses, change what a tool returns, change an ordering the opencode bridge depends on — without touching any suspicious path. Nothing greps that. The `*-drift` rules are deliberately broad for this reason: they say "look here", and the triage step is the actual check, not decoration.

A clean report means no *structural* signal, not a safe merge. The test suite and the `archie-e2e` harness remain the evidence that a merged upstream still works on both backends.
