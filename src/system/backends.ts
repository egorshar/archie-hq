/**
 * Backend resolver (spec §3, §4). Resolves REPO_HOST / AGENT_RUNTIME env into
 * concrete backend factories + capabilities. Phase 0 supports exactly one option
 * per seam (github / claude); the resolver exists so later phases add options
 * without touching call sites. Fails fast with actionable messages at boot.
 */

import type { RepoHost } from '../ports/repo-host.js';
import type { AgentRuntime } from '../ports/agent-runtime.js';
import { getGitHubClient } from '../connectors/github/client.js';
import { claudeSdkRuntime } from '../runtime/claude/runtime.js';
import { logger } from './logger.js';

export type RepoHostKind = 'github' | 'gitlab';
export type AgentRuntimeKind = 'claude' | 'opencode';

const SUPPORTED_REPO_HOSTS: RepoHostKind[] = ['github']; // gitlab: Phase 1
const SUPPORTED_RUNTIMES: AgentRuntimeKind[] = ['claude']; // opencode: Phase 2

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
  const runtime = resolveAgentRuntimeKind();
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    const known: string[] = ['claude', 'opencode'];
    if (known.includes(runtime)) {
      throw new Error(`AGENT_RUNTIME="${runtime}" is not available in this build yet (Phase 0 supports: ${SUPPORTED_RUNTIMES.join(', ')}).`);
    }
    throw new Error(`AGENT_RUNTIME="${runtime}" is invalid. Supported values: ${SUPPORTED_RUNTIMES.join(', ')}.`);
  }
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
    default:
      // Unsupported hosts are rejected by assertBackendConfig() at boot; return
      // null defensively so a mis-sequenced call can't crash.
      logger.warn('backends', `getRepoHost() called for unsupported host "${host}"`);
      return null;
  }
}

/**
 * The active AgentRuntime. Phase 0 supports only 'claude'; the default branch
 * mirrors getRepoHost()'s defensive fallback (assertBackendConfig() rejects
 * unsupported values at boot, so this only guards against a mis-sequenced call).
 */
export function getAgentRuntime(): AgentRuntime {
  const runtime = resolveAgentRuntimeKind();
  switch (runtime) {
    case 'claude':
      return claudeSdkRuntime;
    default:
      // Rejected by assertBackendConfig() at boot; default defensively.
      logger.warn('backends', `getAgentRuntime() called for unsupported runtime "${runtime}"; defaulting to claude`);
      return claudeSdkRuntime;
  }
}
