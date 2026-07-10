# opencode skills-refresh spike — decision record

**Question.** Commit f06b40e re-stages the opencode serve root's `.opencode/skills` on a plugins hot-reload (the DISK layer). Does the RUNNING `opencode serve` reflect that re-stage (new / modified / removed skills), or is the skill surface frozen at serve startup for the process lifetime? This settles whether Part C is docs-only (CASE 1) or must add a managed serve restart (CASE 2).

**CLI version.** `opencode` **1.17.16** (pinned; installed via `npm i --no-save opencode-ai@1.17.16` and run with `PATH="$(pwd)/node_modules/.bin:$PATH"`). SDK `@opencode-ai/sdk@1.17.16`. Model route: `openrouter/z-ai/glm-4.7` (`ARCHIE_OPENCODE_MODEL_DEFAULT`).

## Protocol

Production-parity staging: each skill is a **symlinked dir** built by the real `linkAgentSkills` (`src/agents/skill-linking.ts`) into `<root>/.opencode/skills/`, in a `git init`-bounded `root`, with the `opencode serve` child's cwd = `root` (via the real `startEmbeddedServer` from `embedded-server.ts`). Connected with the SDK's `createOpencodeClient({ baseUrl })`. Each `SKILL.md` carries both `name:` and `description:` frontmatter and a single `PROBE-TOKEN=<marker>` line the model echoes verbatim, so "fresh vs stale" is unambiguous. Every case uses a FRESH `session.create` (except the explicit same-session re-load in Case 2) so session-scoped conversation memory can't mask process-level behavior. The serve is started ONCE; skills are mutated on disk between cases WITHOUT restarting it. Runnable script: `skills-refresh-spike.ts` (same dir).

Note: opencode ships two built-in skills of its own (`customize-opencode`, `usage`); they appear in every list result alongside the staged `probe-*` skills.

## Observed behavior (CLI 1.17.16)

### CASE 1 — baseline (A + B staged before startup)
- list → `customize-opencode, probe-alpha, probe-beta, usage` — both staged skills visible.
- load A → `PROBE-TOKEN=ALPHA-V1`; load B → `PROBE-TOKEN=BETA-V1`. Both load correctly.

### CASE 2 — MODIFY A's content behind its existing symlink (V1 → V2), no restart
- Fresh session, load A → `PROBE-TOKEN=ALPHA-V1`. **STALE** (expected V2).
- Same session, re-load A → `PROBE-TOKEN=ALPHA-V1`. Still stale.
- Verdict: **content is FROZEN.** A brand-new session still sees V1, so the cache is process-wide, not session-scoped. Re-staging the file content is NOT reflected by the running serve.

### CASE 3 — ADD skill C (re-stage A + B + C), no restart
- Fresh session, list → `customize-opencode, probe-alpha, probe-beta, usage`. **`probe-gamma` NOT present.**
- Fresh session, load C → `LOAD-ERROR: Skill "probe-gamma" not found. Available skills: customize-opencode, probe-alpha, probe-beta, usage`.
- Verdict: **the skill LIST is FROZEN.** A skill added after startup is invisible to the running serve, and `probe-gamma` was never accessed before the mutation — so a never-before-seen addition does not appear.

### CASE 4 — REMOVE skill B (re-stage A + C only), no restart
- Fresh session, list → `customize-opencode, probe-alpha, probe-beta, usage`. **`probe-beta` STILL listed** (frozen list).
- Fresh session, load B → `LOAD-ERROR: ripgrep execution failed`.
- Verdict: a removed skill stays in the frozen LIST, but LOADING it now fails — the loader reads the SKILL.md from disk at load time, the symlink is gone, and opencode surfaces a `ripgrep execution failed` error (not a clean "not found"). So the list is startup-frozen while the loader's disk read is live; a removed skill becomes a listed-but-broken entry.

### CASE 5 — rescan-API probe (bonus; best-effort)
- SDK client top-level namespaces: `_client, global, project, pty, config, tool, instance, path, vcs, session, command, provider, find, file, app, mcp, lsp, formatter, tui, auth, event`.
- `client.app` / `client.project` surface only a lazy `_client` proxy; `client.app.init` is NOT present on 1.17.16.
- An `instance` and a `project` namespace DO exist on the client, but their methods were not exercised. **These are undocumented for a skill rescan — do NOT build Part C on them without independent verification.** The spec's hypothesized `Instance.reload` behind `POST /project/git/init` was not confirmed and should not be relied on.

## Verdict: **CASE 2 — frozen at serve startup**

The running `opencode serve` does NOT reflect a post-startup re-stage:
- **LIST is frozen** — added skills never appear; removed skills remain listed. (Case 3, Case 4.)
- **CONTENT is frozen** — a modified SKILL.md still serves the startup content, process-wide across fresh sessions. (Case 2.)
- The only live disk read is the loader fetching a *listed* skill's file at load time, which is why a removed-but-still-listed skill errors (`ripgrep execution failed`) instead of serving stale content. (Case 4.)

First-load-vs-cached nuance: we cannot cleanly separate "scanned at startup" from "cached at first access", because probe-alpha's content and the skill list were both accessed in Case 1 before any mutation. What IS certain and decisive: (1) the freeze is process-wide, not per-session (a fresh session doesn't refresh it); and (2) `probe-gamma`, added in Case 3 and never accessed before, still did not appear — so the list is fixed early (startup or first enumeration) and a later addition can't join it. Either way, an on-disk re-stage alone cannot update a running serve.

**Implication for Part C (decision left to a human — NOT implemented here):** f06b40e's disk re-stage is NECESSARY but NOT SUFFICIENT. To make a plugins hot-reload actually change the skills an opencode agent sees (new/modified/removed), Part C must add a **managed serve restart** after re-staging — there is no confirmed in-process rescan API on 1.17.16. This is a large managed-serve-restart change (drain/replace the shared embedded server), which is exactly why the go/no-go is deferred to a human against this recorded evidence.
