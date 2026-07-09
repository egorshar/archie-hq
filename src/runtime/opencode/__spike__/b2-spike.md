# P2-B.2 spike — read-only enforcement mechanism

Date: 2026-07-09 · harness: `b2-harness.ts` (local opencode CLI + OpenRouter).
Question: how to enforce per-session read-only (block opencode's BUILT-IN edit/bash/write) given `config.permission` is server-global on the shared embedded server.

## Result — decisive
Tested both candidate mechanisms live against the same target file (`SENTINEL` content; prompt asks the model to `edit` it to "CHANGED"):

| Mechanism | Outcome |
|---|---|
| **M1 — plugin `tool.execute.before` throws for edit/write/bash** | ✅ **WORKS.** Hook fired for built-ins (`read`, then `edit`→BLOCKED, then `write`→BLOCKED); target file **unchanged**. |
| **M2 — per-role `config.agent.<name>.permission {edit:'deny'}` via `body.agent`** | ❌ **FAILED.** `archie-ro` (edit:deny) selected via `body.agent` **still edited the file**. Per-agent permission did not enforce (top-level `config.permission.edit:'allow'` appears to win, or `body.agent` didn't bind the agent's permission). Unreliable. |

Capture (M1 before-hook log):
```
BEFORE tool=read  sessionID=ses_...     (allowed)
BEFORE tool=edit  sessionID=ses_...  → BLOCKED edit
BEFORE tool=write sessionID=ses_...  → BLOCKED write
```

## Decision
**RO enforcement = the plugin `tool.execute.before` guard** (per-session, throws to block). It reliably blocks opencode's built-in edit/write (and by extension bash/patch/multiedit — same hook), works on the shared server, and is the anti-corruption mapping of Archie's `PreToolUse` filesystem guard → opencode `tool.execute.before`. Do NOT rely on per-agent `config.permission`.

## B.2 design implications
- The guard runs in the plugin (server child) and sees `input.tool` + `input.sessionID`. It does NOT know the session's RO/edit mode locally (the plugin is generated once, shared). → Add a bridge endpoint the guard queries per call, e.g. `GET /policy?sessionId=...` (bearer-gated) returning `{ readOnly: boolean, blockedTools: string[] }`; the `SessionRegistry` entry carries the mode (from `agent.editModeAtSpawn` / `metadata.edit_allowed`). Cache per-session in the plugin to avoid a round-trip on every tool call if latency matters.
- Block set for RO: opencode built-ins `edit`, `write`, `bash`, `patch`, `multiedit`, `apply_patch` (confirm the live built-in tool names during B.2 — the spike saw `read`/`edit`/`write`; enumerate the rest via the before-hook log or `config.tools`).
- Defense in depth: the bridge `/tool` dispatch also rejects the write repo-tools (`push_branch`, `create_pull_request`, `merge_pull_request`, `update_pr`, `add_pr_comment`, `add_review_comment`, `reply_to_review_comment`, `resolve_review_thread`, `request_re_review`, `close_pull_request`, `create_branch`) for RO sessions — mirrors Archie's existing `disallowedTools` RO list.
- Adversarial RO-escape test (B.2 acceptance): an agent in RO mode attempting file writes / bash / push must be blocked by the guard AND the bridge; the edit-mode agent must succeed.
- Note: `bash` blocked entirely in RO mode means no read-only shell (grep/find) — Archie's Claude RO path allows read-only bash within the sandbox. B.2 decision: start by blocking bash in RO (safest); revisit allowing read-only bash later if agents need it (opencode has no per-command bash sandbox, so blocking is the safe default).
