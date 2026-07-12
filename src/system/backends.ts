/**
 * Backend resolver (spec §3, §4). Resolves REPO_HOST / AGENT_RUNTIME env into
 * concrete backend factories + capabilities. Phase 0 supports exactly one option
 * per seam (github / claude); the resolver exists so later phases add options
 * without touching call sites. Fails fast with actionable messages at boot.
 */

import type { RepoHost } from '../ports/repo-host.js';
import type { AgentRuntime } from '../ports/agent-runtime.js';
import type { LlmOneShot } from '../ports/llm-one-shot.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { GitLabHost } from '../connectors/gitlab/client.js';
import { claudeSdkRuntime } from '../runtime/claude/runtime.js';
import { claudeLlmOneShot } from '../runtime/claude/llm-one-shot.js';
import { opencodeLlmOneShot } from '../runtime/opencode/llm-one-shot.js';
import { opencodeRuntime } from '../runtime/opencode/runtime.js';
import { logger } from './logger.js';

export type RepoHostKind = 'github' | 'gitlab';
export type AgentRuntimeKind = 'claude' | 'opencode';

const SUPPORTED_REPO_HOSTS: RepoHostKind[] = ['github', 'gitlab'];
const SUPPORTED_RUNTIMES: AgentRuntimeKind[] = ['claude', 'opencode'];

export function resolveRepoHostKind(): RepoHostKind {
  const raw = (process.env.REPO_HOST ?? 'github').trim().toLowerCase();
  return raw as RepoHostKind;
}

export function resolveAgentRuntimeKind(): AgentRuntimeKind {
  const raw = (process.env.AGENT_RUNTIME ?? 'claude').trim().toLowerCase();
  return raw as AgentRuntimeKind;
}

export function getBackendMatrix(): { repoHost: string; runtime: string } {
  return { repoHost: resolveRepoHostKind(), runtime: resolveAgentRuntimeKind() };
}

const REQUIRED_GITLAB_ENV = ['GITLAB_BASE_URL', 'GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'] as const;

function assertGitLabEnv(): void {
  const missing = REQUIRED_GITLAB_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`REPO_HOST=gitlab requires ${missing.join(', ')} to be set.`);
  }
}

/**
 * The runtime routes logical model names via ARCHIE_OPENCODE_MODEL_<TIER> /
 * _DEFAULT (see runtime/opencode/model.ts). Require at least one so model
 * resolution can't fail at spawn with no route configured.
 */
function assertOpencodeEnv(): void {
  const hasRoute = Object.keys(process.env).some((k) => k.startsWith('ARCHIE_OPENCODE_MODEL_'));
  if (!hasRoute) {
    throw new Error(
      'AGENT_RUNTIME=opencode requires a model route: set ARCHIE_OPENCODE_MODEL_DEFAULT ' +
      '(or a per-tier ARCHIE_OPENCODE_MODEL_<TIER>, e.g. ARCHIE_OPENCODE_MODEL_OPUS) to a "provider/model" value.',
    );
  }
}

/**
 * Validate selected backends are supported in this build. Throw with an
 * actionable message otherwise. Call once at boot (see index.ts).
 */
export function assertBackendConfig(): void {
  const host = resolveRepoHostKind();
  if (!SUPPORTED_REPO_HOSTS.includes(host)) {
    const known: string[] = ['github', 'gitlab'];
    if (known.includes(host)) {
      throw new Error(`REPO_HOST="${host}" is not available in this build yet (Phase 0 supports: ${SUPPORTED_REPO_HOSTS.join(', ')}).`);
    }
    throw new Error(`REPO_HOST="${host}" is invalid. Supported values: ${SUPPORTED_REPO_HOSTS.join(', ')}.`);
  }
  if (host === 'gitlab') assertGitLabEnv();
  const runtime = resolveAgentRuntimeKind();
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    const known: string[] = ['claude', 'opencode'];
    if (known.includes(runtime)) {
      throw new Error(`AGENT_RUNTIME="${runtime}" is not available in this build yet (Phase 0 supports: ${SUPPORTED_RUNTIMES.join(', ')}).`);
    }
    throw new Error(`AGENT_RUNTIME="${runtime}" is invalid. Supported values: ${SUPPORTED_RUNTIMES.join(', ')}.`);
  }
  if (runtime === 'opencode') assertOpencodeEnv();
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

/**
 * The active AgentRuntime — 'claude' (default) or 'opencode'. The default
 * branch mirrors getRepoHost()'s defensive fallback (assertBackendConfig()
 * rejects unsupported values at boot, so this only guards against a
 * mis-sequenced call).
 */
export function getAgentRuntime(): AgentRuntime {
  const runtime = resolveAgentRuntimeKind();
  switch (runtime) {
    case 'claude':
      return claudeSdkRuntime;
    case 'opencode':
      return opencodeRuntime;
    default:
      // Rejected by assertBackendConfig() at boot; default defensively.
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
