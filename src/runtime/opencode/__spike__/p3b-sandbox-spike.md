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
