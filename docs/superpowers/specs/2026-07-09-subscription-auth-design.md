# Subscription auth for Archie's Claude CLI

Date: 2026-07-09
Status: Design (approved for planning)

## Problem

Archie hard-requires an `ANTHROPIC_API_KEY`. `src/index.ts:72` throws at startup if it is absent, and every path that talks to Claude spawns the Claude Code CLI via the Agent SDK with an explicit env allowlist that lists only `ANTHROPIC_API_KEY` as the credential (`src/agents/spawn.ts:601`, `src/runtime/claude/llm-one-shot.ts:30`). Because the SDK *replaces* `process.env` with that allowlist object (see the comment at `src/agents/spawn.ts:595`), the child CLI never sees any other credential the host might have.

Archie already runs the real Claude Code CLI (`executable: 'node'`), and that CLI natively supports Claude subscription login. So a user with a Claude subscription cannot currently authorize local CLI use without also holding an API key — even though the underlying CLI could. The only blockers are the hard API-key check and the credential allowlist. (The OAuth code already in the repo under `src/system/oauth/` and `src/connectors/oauth/` is for MCP-server auth and is unrelated to Claude auth.)

## Goal

Let Archie authenticate the spawned Claude Code CLI via a Claude subscription in addition to `ANTHROPIC_API_KEY`, everywhere (local and deployed), with auto-detection and a clear precedence order. Preserve today's behavior exactly when an API key is present (zero regression).

## Non-goals

- Owning OAuth token refresh for interactive-login credentials. Durable long-lived operation is served by `claude setup-token`, not by scraping interactive-login state.
- Symlinking or otherwise sharing the host credentials file with concurrently spawned agents (rejected — see Alternatives).
- Any change to MCP-server OAuth.

## Resolution model

A single credential resolver replaces the scattered `ANTHROPIC_API_KEY` reads. It runs a priority chain and returns a small env fragment that the child CLI understands. First match wins:

1. `ANTHROPIC_API_KEY` present → `{ ANTHROPIC_API_KEY }`. Preserves current behavior exactly.
2. `CLAUDE_CODE_OAUTH_TOKEN` present (produced by `claude setup-token`) → `{ CLAUDE_CODE_OAUTH_TOKEN }`. This is the durable subscription path — the token is long-lived and needs no refresh.
3. Best-effort host login → read `~/.claude/.credentials.json`, extract `claudeAiOauth.accessToken`, and return `{ CLAUDE_CODE_OAUTH_TOKEN: <accessToken> }`. Re-read on every spawn so a token refreshed by some other consumer is picked up.
4. Nothing resolved → startup throws with a message listing all three options.

Because every branch delivers the credential through an environment variable, the isolated per-agent `CLAUDE_CONFIG_DIR` set at `src/agents/spawn.ts:609` is left untouched — subscription auth costs us no session/settings isolation.

## Components

New module: `src/system/claude-credential.ts`.

- `claudeCredentialEnv(): Record<string, string>` — runs the priority chain and returns the env fragment. Called fresh at each spawn and each one-shot call, so the per-spawn re-read of host login (path 3) works. The host-login read is wrapped in try/catch: a missing file, a parse error, a missing field, or a macOS Keychain-only setup where no file exists all yield `{}` and fall through to the next branch. This function never throws.
- `assertClaudeCredentialAvailable(): void` — runs the same chain once at startup and throws if it yields nothing. Logs only the resolved *kind*, never the value: `api_key`, `oauth_token (env)`, or `oauth_token (host login, best-effort — short-lived)`.

## Call sites

Three edits wire the resolver in:

- `src/index.ts:72-74` — replace the hard `ANTHROPIC_API_KEY` check with `assertClaudeCredentialAvailable()`.
- `src/agents/spawn.ts:601` — replace the `ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY` entry in the env allowlist with `...claudeCredentialEnv()`.
- `src/runtime/claude/llm-one-shot.ts:30` — the same substitution in that module's env allowlist.

No `HOME` or `CLAUDE_CONFIG_DIR` needs to be added to the child env for the host-login path: the credentials file is read inside the Archie process (which has the full environment), and only the resulting token is passed to the child.

## Error handling and security

- Token values are never logged. Startup and per-spawn logging reports the credential kind only.
- Startup `assertClaudeCredentialAvailable()` is the single gate. If a spawn later produces an empty fragment (for example, a host token that disappeared mid-run), the spawn logs a warning and the child then fails auth on its own — this is an edge case, not a normal path, because startup already asserted at least one source existed.

## Known limitation

Host-login credentials (path 3) are the short-lived subscription access token (roughly hours), paired with a refresh token that Archie deliberately does not use. When a token is supplied through an environment variable the CLI treats it as static and does not refresh it. Therefore path 3 is not suitable for long-lived operation: a single long session can outlive its token, and if Archie is the sole consumer of `~/.claude` nothing refreshes the file for subsequent spawns. Durable long-lived operation must use `claude setup-token` (path 2) or an API key (path 1). This limitation is documented in `.env.example`.

## Alternatives considered

- Symlink the host credentials file into each isolated `CLAUDE_CONFIG_DIR` and allow the CLI to refresh in place. Rejected: OAuth refresh tokens rotate on use, and Archie spawns agents concurrently against one shared file. Concurrent refreshes race on a single-use rotating token and can leave the file torn — which would invalidate the login for the user's own `claude` CLI on that host, not just Archie. It also requires granting sandboxed agents write access to a path outside the workdir, a boundary the sandbox model deliberately never crosses.
- Point `CLAUDE_CONFIG_DIR` at the real `~/.claude`. Rejected: discards the per-agent session/settings isolation the current design relies on.

## Testing

- Unit tests for `claude-credential.ts`: each priority branch, the precedence ordering (API key beats env token beats host login), a malformed or missing credentials file, and the fully-empty result.
- The existing `src/runtime/claude/__tests__/llm-one-shot.test.ts` sets `ANTHROPIC_API_KEY` and asserts it flows into `opts.env` — this still passes via path 1. Add a case asserting an `oauth_token` resolves to `CLAUDE_CODE_OAUTH_TOKEN` in the fragment.

## Docs

- `.env.example`: document `CLAUDE_CODE_OAUTH_TOKEN`, the auto-detect precedence, and the host-login best-effort/short-lived caveat.
- `docs/guides/local-development.md`: add the `claude setup-token` setup step as the subscription option alongside the API key.
