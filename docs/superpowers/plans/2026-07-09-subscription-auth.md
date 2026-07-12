# Subscription Auth for Archie's Claude CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Archie authorize the spawned Claude Code CLI via a Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN` or an interactive `claude login`) in addition to `ANTHROPIC_API_KEY`, with auto-detection and a clear precedence order.

**Architecture:** A single credential resolver (`src/system/claude-credential.ts`) runs a priority chain — API key → `CLAUDE_CODE_OAUTH_TOKEN` env → best-effort read of `~/.claude/.credentials.json` — and returns a small env fragment. That fragment is spread into the two existing SDK env allowlists (`spawn.ts`, `llm-one-shot.ts`), and a startup assert replaces the hard `ANTHROPIC_API_KEY` check. Because every branch delivers the credential through an environment variable, the CLI's isolated `CLAUDE_CONFIG_DIR` is untouched.

**Tech Stack:** Node.js, TypeScript, Vitest. No new dependencies.

## Global Constraints

- Never hard-wrap prose in Markdown/docs — one line per paragraph or bullet (CLAUDE.md).
- Never use `console.*` directly — use `src/system/logger.ts` (CLAUDE.md).
- Never log credential values — log the resolved *kind* only.
- Do not commit files under `docs/superpowers/` (user preference).
- Preserve today's behavior exactly when `ANTHROPIC_API_KEY` is present (zero regression).
- Test runner: `npm test` (`vitest run`). Type check: `npm run typecheck`.
- Only create commits when the executing skill's workflow calls for them; the per-task commit steps below are that workflow.

---

### Task 1: Credential resolver module

**Files:**
- Create: `src/system/claude-credential.ts`
- Test: `src/system/__tests__/claude-credential.test.ts`

**Interfaces:**
- Consumes: `logger` from `src/system/logger.js` (`logger.system(message: string): void`).
- Produces:
  - `type ClaudeCredentialKind = 'api_key' | 'oauth_token_env' | 'oauth_token_host' | 'none'`
  - `resolveClaudeCredential(): { kind: ClaudeCredentialKind; env: Record<string, string> }`
  - `claudeCredentialEnv(): Record<string, string>` — the `env` field of the resolution
  - `assertClaudeCredentialAvailable(): void` — throws when kind is `'none'`, else logs the kind

- [ ] **Step 1: Write the failing tests**

Create `src/system/__tests__/claude-credential.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileSyncMock = vi.fn();
vi.mock('fs', () => ({ readFileSync: (...a: unknown[]) => readFileSyncMock(...a) }));
vi.mock('os', () => ({ homedir: () => '/home/test' }));
const systemMock = vi.fn();
vi.mock('../logger.js', () => ({ logger: { system: (m: string) => systemMock(m) } }));

import {
  resolveClaudeCredential,
  claudeCredentialEnv,
  assertClaudeCredentialAvailable,
} from '../claude-credential.js';

const savedApiKey = process.env.ANTHROPIC_API_KEY;
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(() => {
  readFileSyncMock.mockReset();
  systemMock.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

describe('resolveClaudeCredential', () => {
  it('resolves api_key from ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('api_key');
    expect(r.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('resolves oauth_token_env from CLAUDE_CODE_OAUTH_TOKEN when no api key', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('oauth_token_env');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' });
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('prefers api key over env token', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(resolveClaudeCredential().kind).toBe('api_key');
  });

  it('reads host login access token when no env credentials', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'host-tok' } }),
    );
    const r = resolveClaudeCredential();
    expect(r.kind).toBe('oauth_token_host');
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'host-tok' });
  });

  it('falls through to none on missing/unreadable credentials file', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(resolveClaudeCredential().kind).toBe('none');
  });

  it('falls through to none on malformed json or missing field', () => {
    readFileSyncMock.mockReturnValue('{ not json');
    expect(resolveClaudeCredential().kind).toBe('none');
    readFileSyncMock.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));
    expect(resolveClaudeCredential().kind).toBe('none');
  });
});

describe('claudeCredentialEnv', () => {
  it('returns the env fragment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-env';
    expect(claudeCredentialEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-env' });
  });

  it('returns {} when nothing resolves', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(claudeCredentialEnv()).toEqual({});
  });
});

describe('assertClaudeCredentialAvailable', () => {
  it('throws when no credential is available', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => assertClaudeCredentialAvailable()).toThrow(/No Claude credential/);
  });

  it('logs the resolved kind and does not throw when available', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assertClaudeCredentialAvailable();
    expect(systemMock).toHaveBeenCalledWith('Claude auth: api_key');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- claude-credential`
Expected: FAIL — cannot find module `../claude-credential.js`.

- [ ] **Step 3: Write the module**

Create `src/system/claude-credential.ts`:

```ts
/**
 * Claude credential resolution. Auto-detects, in priority order:
 *   1. ANTHROPIC_API_KEY            — preserves legacy behavior exactly
 *   2. CLAUDE_CODE_OAUTH_TOKEN      — durable subscription token (`claude setup-token`)
 *   3. ~/.claude/.credentials.json  — best-effort interactive `claude login` (short-lived)
 * Each branch normalizes to an env fragment the spawned Claude Code CLI honors,
 * so the CLI's isolated CLAUDE_CONFIG_DIR is left untouched. Token values are
 * never logged — only the resolved kind.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from './logger.js';

export type ClaudeCredentialKind =
  | 'api_key'
  | 'oauth_token_env'
  | 'oauth_token_host'
  | 'none';

export interface ResolvedClaudeCredential {
  kind: ClaudeCredentialKind;
  env: Record<string, string>;
}

function readHostLoginToken(): string | undefined {
  try {
    const path = join(homedir(), '.claude', '.credentials.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.trim() ? token : undefined;
  } catch {
    return undefined;
  }
}

export function resolveClaudeCredential(): ResolvedClaudeCredential {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim()) {
    return { kind: 'api_key', env: { ANTHROPIC_API_KEY: apiKey } };
  }
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim()) {
    return { kind: 'oauth_token_env', env: { CLAUDE_CODE_OAUTH_TOKEN: envToken } };
  }
  const hostToken = readHostLoginToken();
  if (hostToken) {
    return { kind: 'oauth_token_host', env: { CLAUDE_CODE_OAUTH_TOKEN: hostToken } };
  }
  return { kind: 'none', env: {} };
}

export function claudeCredentialEnv(): Record<string, string> {
  return resolveClaudeCredential().env;
}

const KIND_LABEL: Record<ClaudeCredentialKind, string> = {
  api_key: 'api_key',
  oauth_token_env: 'oauth_token (env)',
  oauth_token_host: 'oauth_token (host login, best-effort — short-lived)',
  none: 'none',
};

export function assertClaudeCredentialAvailable(): void {
  const { kind } = resolveClaudeCredential();
  if (kind === 'none') {
    throw new Error(
      'No Claude credential found. Set one of: ANTHROPIC_API_KEY; ' +
        'CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`); ' +
        'or run `claude login` so ~/.claude/.credentials.json exists.',
    );
  }
  logger.system(`Claude auth: ${KIND_LABEL[kind]}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- claude-credential`
Expected: PASS (all cases).

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/system/claude-credential.ts src/system/__tests__/claude-credential.test.ts
git commit -m "feat(auth): Claude credential resolver (API key → OAuth token → host login)"
```

---

### Task 2: Startup gate

**Files:**
- Modify: `src/index.ts` (imports block near line 40; the credential check at lines 72-74)

**Interfaces:**
- Consumes: `assertClaudeCredentialAvailable` from `./system/claude-credential.js` (Task 1).

- [ ] **Step 1: Add the import**

In `src/index.ts`, alongside the other `./system/*` imports (e.g. just after the `./system/context-probe.js` import near line 39), add:

```ts
import { assertClaudeCredentialAvailable } from './system/claude-credential.js';
```

- [ ] **Step 2: Replace the hard API-key check**

Replace the block at `src/index.ts:72-74`:

```ts
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }
```

with:

```ts
  assertClaudeCredentialAvailable();
```

- [ ] **Step 3: Type check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Verify the failure path by hand**

Run: `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN HOME=/nonexistent-home node -e "require('./dist/system/claude-credential.js').assertClaudeCredentialAvailable()"` after a `npm run build`, or rely on the unit test from Task 1 which already covers the throw.
Expected: throws "No Claude credential found…". (If `dist` is inconvenient, this path is already covered by Task 1's `assertClaudeCredentialAvailable` throw test — skip the manual check.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(auth): gate startup on any Claude credential, not just API key"
```

---

### Task 3: Wire the resolver into both SDK env allowlists

**Files:**
- Modify: `src/agents/spawn.ts` (import near the other `../system/*` imports; env allowlist at line 601)
- Modify: `src/runtime/claude/llm-one-shot.ts` (import at top; env allowlist at line 30)
- Test: `src/runtime/claude/__tests__/llm-one-shot.test.ts` (add one case)

**Interfaces:**
- Consumes: `claudeCredentialEnv` from `src/system/claude-credential.js` (Task 1). From `src/runtime/claude/llm-one-shot.ts` the import path is `../../system/claude-credential.js`; from `src/agents/spawn.ts` it is `../system/claude-credential.js`.

- [ ] **Step 1: Add the failing test for the OAuth-token path**

In `src/runtime/claude/__tests__/llm-one-shot.test.ts`, add this case inside the `describe('ClaudeLlmOneShot', ...)` block (after the existing "passes model, systemPrompt, allowedTools, cwd" test):

```ts
  it('passes CLAUDE_CODE_OAUTH_TOKEN into env when no API key is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-tok';
    try {
      queryMock.mockReturnValue(stream([{ type: 'result', subtype: 'success', result: 'ok' }]));
      await claudeLlmOneShot.text({ prompt: 'p', model: 'haiku' });
      const opts = queryMock.mock.calls[0][0].options;
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.ANTHROPIC_API_KEY = 'k';
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- llm-one-shot`
Expected: FAIL — `opts.env.CLAUDE_CODE_OAUTH_TOKEN` is `undefined` (the allowlist still hardcodes only `ANTHROPIC_API_KEY`).

- [ ] **Step 3: Update the one-shot allowlist**

In `src/runtime/claude/llm-one-shot.ts`, add the import after the existing imports (after the `import { query } from './sdk.js';` line):

```ts
import { claudeCredentialEnv } from '../../system/claude-credential.js';
```

Then in `buildOptions`, replace the `env` object (lines 28-32):

```ts
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    },
```

with:

```ts
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      ...claudeCredentialEnv(),
      PATH: process.env.PATH,
    },
```

- [ ] **Step 4: Run the one-shot tests to verify they pass**

Run: `npm test -- llm-one-shot`
Expected: PASS. The existing "passes model…" test still asserts `opts.env.ANTHROPIC_API_KEY === 'k'` (satisfied by the api_key branch, since `beforeEach` sets `ANTHROPIC_API_KEY = 'k'`), and the new case passes.

- [ ] **Step 5: Update the spawn allowlist**

In `src/agents/spawn.ts`, add the import alongside the other `../system/*` imports:

```ts
import { claudeCredentialEnv } from '../system/claude-credential.js';
```

Then in `buildQueryOptions`, replace the single line at `src/agents/spawn.ts:601`:

```ts
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
```

with:

```ts
      ...claudeCredentialEnv(),
```

Leave the surrounding entries (`NODE_ENV`, `PATH`, `HOME`, the `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_TMPDIR` spread, etc.) unchanged.

- [ ] **Step 6: Type check and run the full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/agents/spawn.ts src/runtime/claude/llm-one-shot.ts src/runtime/claude/__tests__/llm-one-shot.test.ts
git commit -m "feat(auth): resolve Claude credential into agent + one-shot SDK env allowlists"
```

---

### Task 4: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/guides/local-development.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the auth options in `.env.example`**

In `.env.example`, near the existing Anthropic/Claude configuration (wherever `ANTHROPIC_API_KEY` is documented; if it is not yet present, add this block near the top with the other core config), add — remember, no hard-wrapping, one line per bullet/paragraph:

```bash
# Claude authentication (auto-detected in priority order):
#   1. ANTHROPIC_API_KEY — standard API key.
#   2. CLAUDE_CODE_OAUTH_TOKEN — durable subscription token from `claude setup-token`. Recommended for subscription auth.
#   3. Interactive `claude login` (~/.claude/.credentials.json) — best-effort convenience for local CLI use only. The access token is short-lived and Archie does not refresh it, so this is NOT suitable for long-running operation.
# At least one must be available or startup fails.
ANTHROPIC_API_KEY=
# CLAUDE_CODE_OAUTH_TOKEN=
```

- [ ] **Step 2: Add the subscription setup step to the local-development guide**

In `docs/guides/local-development.md`, in the environment/setup section that mentions `ANTHROPIC_API_KEY`, add a short subsection (no hard-wrapping):

```markdown
### Claude authentication

Archie auto-detects a Claude credential in priority order: `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then an interactive `claude login`.

To use a Claude subscription instead of an API key, run `claude setup-token` and set the printed token as `CLAUDE_CODE_OAUTH_TOKEN`. This token is durable and works for long-running use.

Alternatively, a prior `claude login` on this machine is picked up automatically (best-effort). Its token is short-lived and not refreshed by Archie, so prefer `setup-token` for anything long-lived.
```

If `docs/guides/local-development.md` has no environment/setup section that references `ANTHROPIC_API_KEY`, add the subsection under the most relevant existing setup heading.

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/guides/local-development.md
git commit -m "docs(auth): document subscription auth via CLAUDE_CODE_OAUTH_TOKEN"
```

---

## Self-Review

**Spec coverage:**
- Resolution model (priority chain, env-fragment normalization) → Task 1.
- Best-effort host-login read with try/catch fallthrough → Task 1 (`readHostLoginToken`, tests for missing/malformed/missing-field).
- `assertClaudeCredentialAvailable` startup gate replacing the hard check → Tasks 1 + 2.
- Both SDK call-site allowlists (`spawn.ts`, `llm-one-shot.ts`) → Task 3.
- Never-log-values / log-kind-only → Task 1 (`KIND_LABEL`, no value in log).
- Known limitation + `.env.example` + local-development docs → Task 4.
- Existing `llm-one-shot.test.ts` still passes via api_key branch → verified in Task 3 Step 4.
- Approach B (symlink) explicitly not implemented → correct, out of scope.

**Placeholder scan:** No TBD/TODO; every code and command step is concrete. The one conditional ("if the guide has no env section…") gives an explicit fallback, not a placeholder.

**Type consistency:** `resolveClaudeCredential` / `claudeCredentialEnv` / `assertClaudeCredentialAvailable` / `ClaudeCredentialKind` names and shapes are used identically across Tasks 1-3. Import paths are given per consumer (`../system/…` from spawn, `../../system/…` from one-shot, `./system/…` from index).
