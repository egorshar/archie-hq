# opencode serve-topology spike — decision record (P3a S1/S2)

**Question.** P3a moves opencode to one `opencode serve` child per agent instance, recycled/reaped through its life. Two branch points gate the design: **S1** — does a session survive a child restart (context-free recycle vs 404→fresh-session + knowledge replay)? **S2** — can a child's cwd be the agent's clone with skills staged in `<clone>/.opencode/skills` (A3 Option 1), or must we keep a synthetic serve root + target the clone another way (Option 2)?

**CLI version.** `opencode` **1.17.16** (pinned; `npm i --no-save opencode-ai@1.17.16`, run with `PATH="$(pwd)/node_modules/.bin:$PATH"`). Model route: `openrouter/z-ai/glm-4.7` (`ARCHIE_OPENCODE_MODEL_DEFAULT`). Runnable script: `serve-topology-spike.ts` (same dir).

## Protocol

Production-parity: real `startEmbeddedServer` (manual spawn, controlled cwd), real `linkAgentSkills` (symlinked skill dirs), `git init`-bounded roots, SDK `createOpencodeClient`. S1 establishes an in-session fact on child #1, kills it, restarts, and prompts the OLD sessionID (a `NotFoundError` = 404; a normal reply = resume; the codeword confirms real context). S2 stages a real skill in the clone and a decoy in a NON-git parent's `.opencode/skills`, then lists skills from `cwd=clone`.

## Observed behavior (CLI 1.17.16)

### S1 — session persistence across a serve-child restart → **CASE RESUME (sessions are GLOBAL)**
- Same-root restart: old sessionID **resumed**, recalled the codeword `ZEBRA-7`. Context preserved.
- **Different-root** restart: old sessionID **also resumed** and recalled `ZEBRA-7`. So sessions are NOT scoped to the serve root / cwd / project — they persist in a **global** store (`~/.local/share/opencode/opencode.db`, a SQLite DB keyed by sessionID) that survives child restarts machine-wide.
- **Verdict:** recycle and reap are **context-free** — a restarted child's next `session.prompt` against the stored sessionID resumes with prior context. No knowledge-log replay needed on recycle/reap.

### S2 — cwd = clone (git worktree), skills in `<clone>/.opencode/skills` → **A3 Option 1 VALID**
- List from `cwd=clone` → `customize-opencode, probe-clone, usage`. The clone's staged `probe-clone` is present; the parent dir's `probe-decoy` is **absent** — opencode's upward discovery walk stops at the clone's git-worktree boundary.
- **Verdict:** cwd = the agent's clone with skills staged into `<clone>/.opencode/skills` works and is self-bounding; no separate synthetic `git init` root is needed for repo agents. Keep a synthetic root only for plugin/PM agents (no clone).
- **Caveat:** the skill *load* probe returned empty text (the model didn't echo the PROBE-TOKEN line) — a glm-4.7 behavior artifact, not a discovery failure (the list clearly discovered the skill). Re-confirm skill *load* content from a clone cwd with a quick check during implementation.

## Implications for P3a (fold into the design)

1. **Recycle/reap are context-free** (S1=RESUME). Drop the 404-branch contingencies from A2: no `opencode-setup.md` context-loss note, no inflated TTL, no knowledge-replay-on-respawn extension. `OPENCODE_CHILD_IDLE_TTL` default stays **15m**. `runPromptTurn`'s 404→fresh-session recovery is retained only as a genuine-loss fallback (stale/GC'd session), not the recycle path.
2. **Serve roots** need not persist for resume (resume is global), but are still kept across child close/reap for staged-skill reuse and removed at task teardown (`evictTask`) — unchanged.
3. **cwd = clone (Option 1)** is the implementation; skills stage into `<clone>/.opencode/skills`, excluded from commits via `.git/info/exclude`. Synthetic root only for clone-less (plugin/PM) agents.
4. **New follow-up (global session store).** Sessions accumulate in a process-global DB and are visible across children — a cleanup and isolation concern. In the container `HOME` is per-container so growth is bounded per container lifetime; on long-lived hosts it grows unboundedly. For P3b, pinning a **per-child data dir** (e.g. per-child `XDG_DATA_HOME`) both isolates one agent's session store from another's and scopes cleanup. Tracked for P3b; not P3a.

This is version-sensitive — re-verify on CLI bumps.
