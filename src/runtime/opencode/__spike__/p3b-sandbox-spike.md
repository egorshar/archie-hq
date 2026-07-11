# P3b sandbox spikes — findings

Date: 2026-07-11. Host: macOS (darwin), no `bwrap` installed (Linux-only). CLI: `opencode-ai@1.17.16` (pinned via `npm i --no-save opencode-ai@1.17.16`; `node_modules/.bin/opencode --version` → `1.17.16`; the host's global `~/.opencode/bin/opencode` is `1.17.18` and was not used). Probe script: `src/runtime/opencode/__spike__/p3b-sandbox-spike.ts` (subcommands `s1`/`s2`/`s3`). Model route under test: `openrouter/z-ai/glm-4.7` (from `ARCHIE_OPENCODE_MODEL_DEFAULT`).

## S1 — bwrap-wrapped `opencode serve` boot

**Verdict: ENV-BLOCKED (darwin host, no bwrap; deferred to Task 6 container live smoke).**

Command: `PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx src/runtime/opencode/__spike__/p3b-sandbox-spike.ts s1`

Output:
```
# S1 — bwrap-wrapped `opencode serve` boot
bwrap not found on this host (darwin dev box; bwrap is Linux-only, not installed here).
VERDICT: ENV-BLOCKED (darwin host, no bwrap; deferred to Task 6 container live smoke).
```

`which bwrap` fails on this host and there is no reachable dev container running an image that ships bwrap (`docker ps` showed only an unrelated `gitlab-runner` container — no archie-e2e container up). Per the plan, S1 is explicitly deferrable; the probe's `s1` path is written and runnable (it builds the representative bwrap argv from the design doc — ro-bind `/usr /bin /lib /lib64 /etc /opt`, `--tmpfs /tmp`, `--proc /proc`, `--dev /dev`, `--bind` scratch cwd + scratch HOME, `--die-with-parent`, `--unshare-pid --unshare-ipc --unshare-uts`, no `--unshare-net`; then boots, connects the SDK client, runs a bash-tool read, and attempts a bash-tool write outside the binds) and only needs a Linux host with `bwrap` on PATH to execute for real.

**Implication for P3b:** no data collected here; treat the P3a-verified spawn/connect mechanics as the load-bearing precedent and re-run `s1` for real inside the Docker image (which already ships bubblewrap per the design doc) before/at Task 6.

## S2 — data-dir + auth under a pinned HOME/XDG_DATA_HOME

**Verdict: PASS.**

Command: `PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx src/runtime/opencode/__spike__/p3b-sandbox-spike.ts s2`

Key output (paths abbreviated to `<home>`/`<cwd>`; full run in the session transcript):
```
HOME=<home> XDG_DATA_HOME=<home> cwd=<cwd>
child #1 booted at http://127.0.0.1:4096
created session ses_0b024acdbffeMyhLEIvSE8QcUp
provider-auth turn (establish codeword) → "OK"
entries under XDG_DATA_HOME after boot:
  <home>/.cache/opencode/...
  <home>/.config/opencode/.gitignore
  <home>/.local/state/opencode/locks/...
  <home>/opencode/log/opencode.log
  <home>/opencode/opencode.db
  <home>/opencode/opencode.db-shm
  <home>/opencode/opencode.db-wal
  <home>/opencode/snapshot/global/...
store present under pinned dir? YES
real ~/.local/share/opencode untouched? YES (existed before: true)
restart (same dataHome) → OLD sessionID resumed. recall: "MANGO-42"
  codeword recalled? YES — resume confirmed
VERDICT: PASS (store-under-pinned-dir=true, real-share-untouched=true; ...)
```

Three things confirmed:
- **`XDG_DATA_HOME` is the env name the CLI honors, and it's read directly (not just derived from `HOME`).** The session store landed at `<XDG_DATA_HOME>/opencode/opencode.db` — a flat `opencode/` child of the pinned dir, not nested under `.local/share/opencode` (which is what the default XDG rule `$HOME/.local/share` would produce). If the CLI only respected `HOME` and computed the data path itself, we'd have seen `.local/share/opencode`; instead the `opencode/` directory sits directly at the pinned dir's root, which only happens if `XDG_DATA_HOME` itself is read and used as the base.
- **The real `~/.local/share/opencode` was untouched** (snapshotted before/after by mtime; identical).
- **Provider auth via `OPENROUTER_API_KEY` resolves under the pinned dir** — a real model turn completed ("OK").
- **Resume works**: a session created against child #1 (root+home) was recalled correctly (the planted codeword `MANGO-42` came back verbatim) after child #1 was killed and child #2 booted pointed at the exact same `cwd`+`XDG_DATA_HOME`/`HOME`.

**Implication for P3b:** confirmed `XDG_DATA_HOME` is the correct/sufficient env knob for per-agent store isolation (paired with `HOME` for `.config`/`.cache`/`.local/state`, which the CLI also uses but which aren't the isolation target); the P3b per-agent `<workdir>/opencode-server/<taskId>/<agentId>/home` design (used for both `HOME` and `XDG_DATA_HOME`) is validated end-to-end, including the resume-across-restart requirement carried over from P3a.

## S3 — proxy compliance

**Verdict: PASS.**

Command: `PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx src/runtime/opencode/__spike__/p3b-sandbox-spike.ts s3`

Key output:
```
proxy listening on 127.0.0.1:62350, allowlist=[openrouter.ai]
bridge stub listening on 127.0.0.1:62349 (NOT on the proxy allowlist — reachability depends solely on NO_PROXY)
child env: HTTPS_PROXY=http://127.0.0.1:62350 NO_PROXY=127.0.0.1,localhost
[proxy] DENIED CONNECT models.dev:443
booted at http://127.0.0.1:4096
[proxy] DENIED CONNECT models.dev:443
[proxy] DENIED CONNECT 1bf.sweed.tech:443
[proxy] DENIED CONNECT 1bf.sweed.tech:443
[proxy] ALLOWED CONNECT openrouter.ai:443
model turn via proxy → "PONG"
proxy connect-log entry for openrouter.ai? YES ({"host":"openrouter.ai","port":443,"allowed":true}) — call actually routed through the proxy
[proxy] DENIED CONNECT example.com:443
webfetch non-allowlisted host → "StatusCode: non 2xx status code (403 GET https://example.com/)"
proxy connect-log entry for example.com? {"host":"example.com","port":443,"allowed":false}
webfetch loopback (NO_PROXY) → "BRIDGE-OK"
proxy connect-log entry for loopback? NO entry — confirms NO_PROXY bypassed the proxy for loopback
VERDICT: see the three sub-findings above ...
```

Three sub-findings, all confirmed with proxy-side evidence (not just "the reply arrived" — the probe's tiny CONNECT proxy logs every CONNECT attempt with allow/deny, so a bypassed proxy would be distinguishable from a used one):
- **Bun's fetch (the CLI's own internal HTTP client) honors `HTTPS_PROXY`.** The real model turn to `openrouter.ai` shows up in the proxy's connect log as `ALLOWED CONNECT openrouter.ai:443`, and the model replied "PONG" — the call demonstrably went through the proxy, not direct.
- **A non-allowlisted host is denied with a clean 403** surfaced back through the tool call: asking the model to `webfetch` `https://example.com/` produced `StatusCode: non 2xx status code (403 GET https://example.com/)`, with the proxy log showing `DENIED CONNECT example.com:443`.
- **`NO_PROXY=127.0.0.1,localhost` correctly bypasses the proxy for loopback.** A `webfetch` to a local stub HTTP server on `127.0.0.1` (deliberately NOT on the proxy's allowlist) succeeded directly ("BRIDGE-OK") with **no corresponding entry in the proxy's connect log at all** — proving the request never reached the proxy (bypassed via `NO_PROXY`), not that the proxy allowed it by mistake. This is the discriminator for the plugin→bridge loopback callback requirement.

**Bonus finding (unplanned, useful):** the opencode CLI itself makes background egress calls beyond the model-provider route — `models.dev:443` (model-catalog/registry fetch) and `1bf.sweed.tech:443` (looks like a telemetry/analytics endpoint) — both denied by our intentionally narrow allowlist. The CLI did not crash or hang on either denial; it proceeded and completed the real model turn regardless. This means the CLI degrades gracefully when non-essential background egress is blocked, but it also means a strict allowlist limited to `PROVIDER_EGRESS_HOSTS` will silently deny these two hosts every child boot — worth a deliberate decision in the profile-assembly task (Task 4) rather than an accidental byproduct: either add `models.dev` (and whatever `1bf.sweed.tech` is) to a small "CLI baseline" allowlist entry, or explicitly accept the denial as intended (the CLI clearly tolerates it) and note it so a future debugging session doesn't mistake the repeated warn line for a real problem.

**Implication for P3b:** confirmed Bun's fetch (used for the provider route AND the CLI's own auxiliary calls) honors `HTTPS_PROXY`/`NO_PROXY` end-to-end through a CONNECT proxy exactly as `egress-proxy.ts` (Task 3) is designed to be used; confirmed the loopback bridge-callback path is safe under the proxy design via `NO_PROXY`; flagged the CLI's own `models.dev`/telemetry egress as a Task 4 allowlist-scope decision, not a blocker.

## Cleanup

All `opencode serve` children spawned by the three probe runs were killed by the probe's own `finally` blocks except one: an `s3` dry run crashed the harness (unhandled `ECONNRESET` on the proxy's CONNECT socket before the client-error listener was attached — fixed in the script) and left one orphaned `opencode serve` child (PID 26501, reparented to PID 1). Verified via `lsof -p 26501 | grep cwd` that its cwd was the probe's own scratch dir (`archie-p3b-s3-cwd-*`), not the live Archie dev server, then killed it and removed its temp dir. After the fix, `s3` reran cleanly through its own `finally` cleanup. Final check: `pgrep -fl "opencode serve"` → no processes running.

## Live container smoke (P3b Task 6)

Date: 2026-07-11. Host: macOS (darwin) controller.

**Status: ENV-BLOCKED.** Not attempted, for two independent reasons, either of which alone would block it:

- This is a darwin controller host. `bwrap` is Linux-only by design (it wraps Linux namespace syscalls) — it cannot run here regardless of container availability.
- The `archie-e2e` Docker instance cannot be booted from this host right now: a live Archie dev server is already running locally, and the E2E harness's Docker container collides with it on the same `.env` (same Slack app credentials) and the same `./workdir` bind-mount. Booting the container alongside the live dev server would corrupt both.

No pass is claimed for anything in this section — this records what was NOT run and why, plus what IS verified without it, plus the exact runbook for whoever runs it next on a Linux host with the local dev server stopped first.

### What IS verified without the container

- **The bwrap argv builder** (`buildSandboxArgv`, `profileFingerprint`) — full unit coverage in `src/runtime/opencode/__tests__/child-sandbox.test.ts`: mount ordering (system ro-binds → agent ro-binds → agent rw binds → deny re-bind, emitted ONLY for a deny path inside an rw region so it downgrades rather than shadows), the three agent-kind shapes (RO repo agent: clone ro + `clone/.opencode` rw carve NOT shadowed by the clone-root deny; edit-mode repo agent: clone rw + `.git/HEAD` downgraded; synthetic root: cwd bound rw), hardening flags present, `--unshare-net` absent, nonexistent bind sources skipped, and the Linux fail-closed throw when `bwrap` is unavailable; plus fingerprint stability/sensitivity to mount/allowlist changes.
- **The egress proxy** — `src/runtime/opencode/__tests__/egress-proxy.test.ts` drives real loopback CONNECT/HTTP round-trips against the actual `net.Server` (not a mock): allowed CONNECT, denied CONNECT (403), missing/bad credential (407), per-child credential scoping (one child's cred can't reach another child's allowlist), revocation, and the `hostAllowed` exact/dot-suffix/`host:port` matching rules.
- **The profile assembler** — `src/runtime/opencode/__tests__/child-sandbox-profile.test.ts`: `buildChildSandboxProfile`/`buildOneShotSandboxProfile` allowlist composition (provider-or-throw, repo-host-only-for-repo-agents, registries edit-mode-only, declared-MCP-hosts-only, frontmatter domains), `buildChildEnv` pruning (base allowlist + `LC_*` + pinned `HOME`/`XDG_DATA_HOME` + proxy vars + only the route provider's key — no secret leakage), and `agentProfileFingerprint` agreeing with the built profile's own fingerprint.
- **The pool / one-shot / embedded-server wiring** — `src/runtime/opencode/__tests__/serve-pool.test.ts`, `llm-one-shot.test.ts`, and `embedded-server.test.ts`: `startEmbeddedServer` uses `spawnOverride`/`env` verbatim (never spread with `process.env`), `bootChild` mints and later revokes the egress credential (including on boot-failure paths), `getAgentServe`'s warm-path fingerprint recompute triggers a mode-transition recycle on a mount/allowlist flip, and `closeServePool`/`closeOneShotServe` revoke every live credential on shutdown.
- **The Task 1 spikes**, above in this same file, proved the cooperative egress layer live against the real `openrouter.ai` provider (S3): an allowed CONNECT completed a real model turn ("PONG"), a non-allowlisted host (`example.com`) was denied with a clean 403 surfaced back through the tool call, and `NO_PROXY=127.0.0.1,localhost` correctly bypassed the proxy for the loopback bridge callback (confirmed by the proxy's own connect log showing no entry for that call, not just that the reply arrived). S2 proved `XDG_DATA_HOME`/`HOME` store isolation end-to-end, including session resume across a child restart when pointed at the same pinned dir, and that the real `~/.local/share/opencode` was left untouched.

None of the above exercises `bwrap` itself — the argv builder is unit-tested for what flags it *produces*, not that those flags actually enforce a jail when handed to a real `bwrap` binary. That gap is exactly what the runbook below closes.

### Runbook for whoever runs this on Linux

Prerequisite: stop the local dev server first (or run this on a host/VM with no other instance holding the same `.env`/`./workdir`) — see the `E2E boot shares .env/workdir/Slack` collision note. Then, using the `archie-e2e` skill against this branch:

1. Boot the branch in the dev container (Docker, which already ships `bwrap`+`socat` per `Dockerfile.dev`).
2. Drive the `archie-e2e` basic scenario (PM + one repo agent, edit-mode if you want the trusted-registry allowlist entries exercised too).
3. Verify, in order:
   1. **Children spawn under `bwrap`.** `ps aux | grep "bwrap.*opencode serve"` (or inspect the process command line another way) shows the agent's serve child's argv starting with `bwrap` and the expected flags, not a bare `opencode serve`.
   2. **The filesystem jail actually holds.** From inside the jail (e.g. via the agent's own bash tool, prompted through a task), `cat /app/package.json` (or any other repo-root file outside the agent's allowed read/write paths) **fails**, and a write attempt outside the bound mounts (e.g. `touch /app/should-fail`) **fails**.
   2b. **The read-only repo agent's `.opencode` carve-out survives (C1).** Boot a repo agent WITHOUT edit mode (read-only) and confirm, from inside its jail: a write to the clone root (e.g. `touch <clone>/should-fail`) **fails** (clone is read-only) while a write under `<clone>/.opencode` (e.g. `touch <clone>/.opencode/probe`) **succeeds** — the rw carve-out is not shadowed by the clone-root deny re-bind. If the RO child fails to boot at all (opencode's boot-time plugin-dep write into `.opencode` failing), that is the exact C1 regression this scenario guards.
   3. **The egress proxy actually holds — for the serve process's own traffic.** The model turn itself succeeds (proves the allowed provider route works end-to-end through the jail+proxy), and a `webfetch` to a non-allowlisted host is **denied** — check the egress-proxy's own log for a `DENY` line for that host, not just that the fetch failed. Note the scope: this proxy filters the serve process's OWN `fetch` (model/webfetch/remote-MCP), NOT `bash`-spawned subprocesses. A `curl https://example.com` from the agent's bash tool will likely **succeed** (curl doesn't inherit the serve process's proxy env — the `opencode-bash-env-isolation` reality), and that success is NOT a proxy failure; it's expected until the clone-local-git-config follow-up lands. The meaningful evidence is the serve's own model/webfetch traffic in the proxy log, not a bash `curl`.
   4. **Session store isolation.** Confirm (from the host, since `/private/tmp`... i.e. `<workdir>` is host-visible via the bind mount) that the agent's opencode session store lands under `<workdir>/opencode-server/<taskId>/<agentId>/home`, not under any shared `~/.local/share/opencode`.
   5. **Env pruning.** `bwrap ... env | grep -c SLACK` (or equivalent — dump the child's actual env, e.g. via `/proc/<pid>/environ` on the host, or an in-jail `env` call through the agent's bash tool) returns `0` for `SLACK_*` and `GITLAB_*` — none of the orchestrator's own secrets reached the child.
   6. **Teardown cleans up.** After the task completes/is torn down, confirm the per-agent home dir under `<workdir>/opencode-server/<taskId>/<agentId>/` no longer exists.
4. Also re-confirm the Task-1 S3 finding under the real jail+proxy: the opencode CLI's own background `models.dev`/telemetry calls should still be denied by the allowlist (expect repeated `DENY` log lines for those hosts) while the model turn itself still completes — i.e. the CLI keeps degrading gracefully rather than hanging or erroring on that denial. If the CLI's model *resolution* itself breaks (as opposed to just the background telemetry call), that's a real regression and `models.dev` needs to be added as a follow-up allowlist entry (a "CLI baseline" host set), not silently worked around.

Record the pass/fail for each check, the opencode CLI version used, and the run date when this is actually executed — do not backfill a pass into this section without having run it.

## Live container smoke — RUN 2026-07-11 (CLI 1.17.16, bwrap 0.11.0, branch feat/phase-3a-serve-topology @ aa65543)

Booted the branch in the real Docker container (opencode + gitlab) via the archie-e2e harness (port 3030, attested aa65543-dirty), drove a read-only `basic-nonce` task (PM agent). Verified by `docker exec` / host inspection of the bind-mounted `./workdir` (in-jail `nsenter` + `/proc/<pid>/environ` reads were blocked by the unprivileged container's missing CAP_SYS_ADMIN/PTRACE — the bwrap argv + host-side artifacts stand in).

**PASS — bwrap filesystem jail applied.** The PM child ran as a real `bwrap`-wrapped process (pid 229). Captured argv: `--ro-bind /usr /bin /lib /lib64 /etc /opt /sbin`, `--tmpfs /tmp --proc /proc --dev /dev`, `--ro-bind` the agent workspace/shared/plugin-data, `--bind` (rw) the workspace + the serve root + `.opencode` + the per-agent `home`, `--ro-bind` the `.claude` protected files, `--die-with-parent --unshare-pid --unshare-ipc --unshare-uts`, and **NO `--unshare-net`** (loopback preserved — the bridge listener + SDK client worked). `/app` and `/workdir/repos` are absent from the mount set (fs boundary by construction).

**PASS — cooperative egress proxy enforcing.** Logs show `egress DENY (connect) → models.dev:443` and `→ registry.npmjs.org:443` (non-allowlisted hosts, correctly denied for a non-repo agent). The provider call succeeded silently (allowed connects are not logged): the child streamed `providerID=openrouter modelID=z-ai/glm-5.2` — so the OpenRouter key reached the child and `openrouter.ai` egress was permitted. `models.dev` denial degraded gracefully (the model still streamed), confirming the Task-1 spike finding under the real jail.

**PASS — per-agent session-store isolation.** The store landed at `<workdir>/opencode-server/<task>/pm-agent/home/opencode/opencode.db` (+ `-wal`/`-shm`/`log`). The orchestrator's `~/.local/share/opencode` does not exist — no leak to a global store. DB size after the scripted turn: ~a few hundred KB (single session, a handful of turns).

**FAIL (merge blocker) — the egress allowlist breaks the bridge plugin's dependency install for non-(edit-mode-repo) agents.** opencode installs the bridge plugin's own dependency `@opencode-ai/plugin` from `registry.npmjs.org` at child boot into the staged `.opencode/node_modules`. The P3b allowlist grants `TRUSTED_PACKAGE_REGISTRY_DOMAINS` only to **edit-mode repo agents**, so for the PM (and every plugin / read-only repo agent) the install is 403-denied → `@opencode-ai/plugin` is absent → the bridge plugin's `import { tool } from "@opencode-ai/plugin"` fails → the bridge registers zero tools. Observed: `background dependency install failed … 403 … @opencode-ai/plugin`, `@opencode-ai` absent from the staged `.opencode/node_modules`, and ZERO bridge activity (no `/tools` manifest fetch, no `post_to_user`/`report_completion` dispatch). The PM's turn ran (model streamed, it read the knowledge log) but could not deliver a user reply → task idled → recovery → `stopped`. Pre-sandbox live runs (P2/P3a) never hit this because the child had open egress.

Root cause is architectural: the bridge plugin's runtime dependency must be available to EVERY agent's child without per-agent registry egress. Fix options (design decision): (A) **vendor `@opencode-ai/plugin` into the staged `.opencode/node_modules` at staging time** (orchestrator-provided, no network install — matches the orchestrator-controlled philosophy, keeps egress tight) — recommended; (B) add `registry.npmjs.org`/`registry.yarnpkg.com` to the allowlist for all agents (simpler, widens egress); (C) point the child's npm at an offline/vendored cache. Until fixed, opencode under the P3b sandbox cannot complete a PM turn.

**Deferred (unverified live):** the in-jail `/app`-read-fails / out-of-mount-write-fails probes and the child-env secret-absence assertion (both needed CAP_SYS_ADMIN/PTRACE the unprivileged container lacks) — covered by the bwrap argv (fs) and unit tests (env pruning) respectively. The RO-repo-agent `.opencode` carve-out (the C1 fix) was NOT exercised: the gitlab token in the container is expired, so repo agents couldn't clone/investigate — only the PM (synthetic-root) path ran.

## Bridge-dep vendoring fix — RE-SMOKE 2026-07-11 (Option A, verified live in container)

Fix: pin `@opencode-ai/plugin@1.17.16` in package.json (lockstep with `@opencode-ai/sdk` + the Dockerfile CLI pin) and vendor it — self-contained incl. its nested `zod@4.1.8`, the only dep the bridge's `tool` entry pulls in — into each child's `.opencode/node_modules` at boot (`skills.ts vendorBridgeDeps`, wired into `serve-pool.ts bootChild`; idempotent, best-effort+warn). opencode's Bun then resolves the bridge plugin's `import { tool } from "@opencode-ai/plugin"` offline, so the boot-time npm auto-install the egress jail blocked never runs.

Re-smoke (rebuilt image via `docker compose down -v` to refresh the anonymous node_modules volume; boot on port 3030): **PASS.** Confirmed `@opencode-ai/plugin` (+ nested zod 4.1.8) present in `/app/node_modules`; mid-turn the same package is present in the staged child `.opencode/node_modules`; the PM turn **completed** (was `stopped`) and delivered a real bridged reply (`[pm-agent in cli] Configured agents … 1. backend-agent … 5. release-manager-agent`) — so the bridge loaded and `post_to_user`/`report_completion` worked. No `@opencode-ai/plugin` dependency-install failure this run. The residual `egress DENY → registry.npmjs.org` / `models.dev` lines are opencode's unrelated background npm/model-catalog probes and are harmless (turn completed). Two consecutive tasks completed cleanly. Teardown clean.

Still not exercised live (unchanged from the prior run): the in-jail `/app`-read / out-of-mount-write probes + child-env secret-absence (unprivileged-container caps) and the RO-repo `.opencode` carve-out (container gitlab token expired → only the PM synthetic-root path runs).

## FULL LIVE COVERAGE — 2026-07-11 (container, both clone profiles + in-jail nsenter probes)

Re-ran the container smoke with a TEMPORARY compose override granting the container `SYS_ADMIN`+`SYS_PTRACE` (untracked `docker-compose.override.yml`, removed after) so the harness could `nsenter` into a child's namespaces and read `/proc/<pid>/environ` for DEFINITIVE in-jail probes — this does NOT change what bwrap does to the child, only what the inspector can see. Repo agents spawned against the existing local base clones (no fresh GitLab token needed for RO work or a locally-created RW clone; no push attempted). Both C1 branches are now proven live:

**RO repo agent (backend, read-only investigation) — task COMPLETED.** bwrap argv: `--ro-bind <clone>`, `--ro-bind <clone>/.git/objects`, `--bind <clone>/.opencode`, `--bind <agent home>`, hardening flags, no `--unshare-net`. In-jail (`nsenter`): READ `/app` DENIED; WRITE clone-root DENIED (ro); WRITE `clone/.opencode` SUCCEEDED (the C1 rw carve-out survives — not shadowed); WRITE `/etc` DENIED. Child env: 0 `SLACK_/GITLAB_/GITHUB_` vars, `OPENROUTER_API_KEY` present, `HTTPS_PROXY` set, `XDG_DATA_HOME` = the per-agent dir.

**Edit-mode repo agent (backend, RW clone after edit-mode approval via `POST /approve`) — approval flow worked.** bwrap argv: `--ro-bind <clone>` THEN `--bind <clone>` (writable), `--bind <clone>/.opencode`, `--bind <agent home>`, then `--ro-bind <clone>/.git/HEAD` LAST (the deny re-ro-bind). In-jail: READ `/app` DENIED; WRITE clone-root SUCCEEDED (rw — edit mode); WRITE `clone/.git/HEAD` DENIED ("Read-only file system" — the deny downgrade holds even on the rw clone); WRITE base-repo path outside this agent's mounts DENIED. Child env: 0 secret vars.

**Coverage now complete:** bwrap fs jail (both profiles) + the C1 fix (RO carve + RW deny) + `/app`/out-of-mount/`/etc` write denial + egress proxy enforcing (non-allowlisted denied incl. models.dev/registry/telemetry/github, provider allowed) + per-agent session-store isolation + env pruning + the bridge working end-to-end (PM + RO repo task completed). On the strength of this, `OPENCODE_RUNTIME_CAPABILITIES.osSandbox` is flipped to `true` (Linux posture; darwin dev unwrapped remains the documented caveat). Deferred follow-ups unchanged (Option B `--unshare-net`, bash-subprocess egress via git config, per-child uid, TTL session cleanup).
