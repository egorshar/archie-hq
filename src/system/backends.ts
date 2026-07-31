/**
 * Backend resolver. Resolves the pluggable-backend env selectors into concrete
 * implementations behind stable accessors, so call sites never branch on which
 * backend is active. Fails fast with actionable messages at boot.
 *
 * - AGENT_RUNTIME → AgentRuntime + LlmOneShot: `claude` (default) or `opencode`.
 * - REPO_HOST → RepoHost: `github` (default) or `gitlab`.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentRuntime } from '../ports/agent-runtime.js';
import type { LlmOneShot } from '../ports/llm-one-shot.js';
import type { RepoHost } from '../ports/repo-host.js';
import { claudeSdkRuntime } from '../runtime/claude/runtime.js';
import { claudeLlmOneShot } from '../runtime/claude/llm-one-shot.js';
import { opencodeLlmOneShot } from '../runtime/opencode/llm-one-shot.js';
import { opencodeRuntime } from '../runtime/opencode/runtime.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { GitLabHost } from '../connectors/gitlab/client.js';
import { logger } from './logger.js';

export type AgentRuntimeKind = 'claude' | 'opencode';
export type RepoHostKind = 'github' | 'gitlab';

const SUPPORTED_RUNTIMES: AgentRuntimeKind[] = ['claude', 'opencode'];
const SUPPORTED_REPO_HOSTS: RepoHostKind[] = ['github', 'gitlab'];

export function resolveAgentRuntimeKind(): AgentRuntimeKind {
  const raw = (process.env.AGENT_RUNTIME ?? 'claude').trim().toLowerCase();
  return raw as AgentRuntimeKind;
}

export function resolveRepoHostKind(): RepoHostKind {
  const raw = (process.env.REPO_HOST ?? 'github').trim().toLowerCase();
  return raw as RepoHostKind;
}

export function getBackendMatrix(): { runtime: string; repoHost: string } {
  return { runtime: resolveAgentRuntimeKind(), repoHost: resolveRepoHostKind() };
}

/** True when an `opencode` executable is resolvable on PATH. */
function opencodeCliOnPath(): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, 'opencode')));
}

/**
 * The runtime routes logical model names via ARCHIE_OPENCODE_MODEL_<TIER> /
 * _DEFAULT (see runtime/opencode/model.ts). Require at least one so model
 * resolution can't fail at spawn with no route configured. Also require the
 * `opencode` CLI on PATH — the embedded server spawns `opencode serve`, and its
 * absence otherwise surfaces only at first agent spawn (a serve-spawn ENOENT),
 * not at boot. The Docker images install the CLI only when built for the
 * opencode runtime (AGENT_RUNTIME build arg), so a claude-built image run with
 * AGENT_RUNTIME=opencode trips exactly this check.
 */
function assertOpencodeEnv(): void {
  const hasRoute = Object.keys(process.env).some((k) => k.startsWith('ARCHIE_OPENCODE_MODEL_'));
  if (!hasRoute) {
    throw new Error(
      'AGENT_RUNTIME=opencode requires a model route: set ARCHIE_OPENCODE_MODEL_DEFAULT ' +
      '(or a per-tier ARCHIE_OPENCODE_MODEL_<TIER>, e.g. ARCHIE_OPENCODE_MODEL_OPUS) to a "provider/model" value.',
    );
  }
  if (!opencodeCliOnPath()) {
    throw new Error(
      'AGENT_RUNTIME=opencode requires the `opencode` CLI on PATH, but it was not found. ' +
      'The embedded server spawns `opencode serve`. In Docker, build the image for the opencode runtime ' +
      '(set AGENT_RUNTIME=opencode at build time — docker compose reads it from .env); for a local install, ' +
      'run `npm install -g opencode-ai@<version matching @opencode-ai/sdk>`.',
    );
  }
}

const REQUIRED_GITLAB_ENV = ['GITLAB_BASE_URL', 'GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'] as const;

function assertGitLabEnv(): void {
  const missing = REQUIRED_GITLAB_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`REPO_HOST=gitlab requires ${missing.join(', ')} to be set.`);
  }
}

/**
 * Validate the selected backends are supported in this build. Throw with an
 * actionable message otherwise. Call once at boot (see index.ts).
 */
export function assertBackendConfig(): void {
  const runtime = resolveAgentRuntimeKind();
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    throw new Error(`AGENT_RUNTIME="${runtime}" is invalid. Supported values: ${SUPPORTED_RUNTIMES.join(', ')}.`);
  }
  if (runtime === 'opencode') assertOpencodeEnv();
  const host = resolveRepoHostKind();
  if (!SUPPORTED_REPO_HOSTS.includes(host)) {
    throw new Error(`REPO_HOST="${host}" is invalid. Supported values: ${SUPPORTED_REPO_HOSTS.join(', ')}.`);
  }
  if (host === 'gitlab') assertGitLabEnv();
}

/**
 * The active AgentRuntime — 'claude' (default) or 'opencode'. The default
 * branch guards against a mis-sequenced call (assertBackendConfig() rejects
 * unsupported values at boot).
 */
export function getAgentRuntime(): AgentRuntime {
  const runtime = resolveAgentRuntimeKind();
  switch (runtime) {
    case 'claude':
      return claudeSdkRuntime;
    case 'opencode':
      return opencodeRuntime;
    default:
      logger.warn('backends', `getAgentRuntime() called for unsupported runtime "${runtime}"; defaulting to claude`);
      return claudeSdkRuntime;
  }
}

/**
 * The active LlmOneShot (one-shot prompt→text/JSON calls). Tied to the agent
 * runtime selection: opencode when AGENT_RUNTIME=opencode, otherwise the Claude
 * SDK impl (default).
 */
export function getLlmOneShot(): LlmOneShot {
  return resolveAgentRuntimeKind() === 'opencode' ? opencodeLlmOneShot : claudeLlmOneShot;
}

let gitlabSingleton: GitLabHost | null = null;
export function getGitLabHost(): GitLabHost {
  if (!gitlabSingleton) gitlabSingleton = new GitLabHost();
  return gitlabSingleton;
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
    case 'gitlab':
      return getGitLabHost();
    default:
      // Unsupported hosts are rejected by assertBackendConfig() at boot; return
      // null defensively so a mis-sequenced call can't crash.
      logger.warn('backends', `getRepoHost() called for unsupported host "${host}"`);
      return null;
  }
}
