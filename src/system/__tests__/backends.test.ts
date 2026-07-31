import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

// Isolate backends.ts's import of the GitLab connector so this unit test
// doesn't pull the real client's module graph. NOTE: this specifier must
// stay textually identical to the import in backends.ts (not re-derived from
// this file's own relative path) — Vitest's mock matching falls back to raw
// specifier text rather than a canonicalized path.
vi.mock('../connectors/gitlab/client.js', () => ({
  GitLabHost: class {},
}));

import {
  resolveAgentRuntimeKind,
  resolveRepoHostKind,
  assertBackendConfig,
  getBackendMatrix,
  getAgentRuntime,
} from '../backends.js';

// A temp dir holding a stub `opencode` binary, so the opencode PATH check in
// assertBackendConfig can be satisfied deterministically regardless of the host.
let opencodeBin: string;
beforeAll(() => {
  opencodeBin = mkdtempSync(join(tmpdir(), 'oc-bin-'));
  writeFileSync(join(opencodeBin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
});

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe('backends config resolver', () => {
  it('defaults the agent runtime to claude when AGENT_RUNTIME is unset', () => {
    delete process.env.AGENT_RUNTIME;
    expect(resolveAgentRuntimeKind()).toBe('claude');
  });

  it('honors AGENT_RUNTIME=claude explicitly', () => {
    process.env.AGENT_RUNTIME = 'claude';
    expect(resolveAgentRuntimeKind()).toBe('claude');
  });

  it('reports the resolved matrix', () => {
    delete process.env.AGENT_RUNTIME;
    delete process.env.REPO_HOST;
    expect(getBackendMatrix()).toEqual({ runtime: 'claude', repoHost: 'github' });
  });

  it('accepts AGENT_RUNTIME=opencode when a model route is configured and the CLI is on PATH', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'anthropic/claude-haiku-4-5';
    process.env.PATH = `${opencodeBin}${delimiter}${process.env.PATH ?? ''}`;
    expect(() => assertBackendConfig()).not.toThrow();
  });

  it('rejects AGENT_RUNTIME=opencode when the opencode CLI is not on PATH, actionably', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'anthropic/claude-haiku-4-5';
    process.env.PATH = ''; // no directory on PATH contains an `opencode` binary
    expect(() => assertBackendConfig()).toThrow(/opencode` CLI on PATH/);
  });

  it('rejects AGENT_RUNTIME=opencode with no model route, actionably', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
    delete process.env.ARCHIE_OPENCODE_MODEL_OPUS;
    delete process.env.ARCHIE_OPENCODE_MODEL_SONNET;
    expect(() => assertBackendConfig()).toThrow(/ARCHIE_OPENCODE_MODEL/);
  });

  it('rejects an invalid AGENT_RUNTIME value', () => {
    process.env.AGENT_RUNTIME = 'gpt';
    expect(() => assertBackendConfig()).toThrow(/AGENT_RUNTIME/);
  });

  it('getAgentRuntime returns the opencode runtime for AGENT_RUNTIME=opencode', () => {
    process.env.AGENT_RUNTIME = 'opencode';
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'anthropic/claude-haiku-4-5';
    expect(getAgentRuntime().kind).toBe('opencode');
  });

  it('getAgentRuntime returns the claude runtime by default', () => {
    delete process.env.AGENT_RUNTIME;
    expect(getAgentRuntime().kind).toBe('claude');
  });

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

  it('rejects REPO_HOST=gitlab when GITLAB_* is unconfigured', () => {
    process.env.REPO_HOST = 'gitlab';
    delete process.env.GITLAB_BASE_URL;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_WEBHOOK_SECRET;
    expect(() => assertBackendConfig()).toThrow(/GITLAB_BASE_URL/i);
  });

  it('accepts REPO_HOST=gitlab when GITLAB_* is configured', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BASE_URL = 'https://gl.example';
    process.env.GITLAB_TOKEN = 't';
    process.env.GITLAB_WEBHOOK_SECRET = 's';
    expect(() => assertBackendConfig()).not.toThrow();
    expect(resolveRepoHostKind()).toBe('gitlab');
  });
});
