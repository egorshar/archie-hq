/**
 * Mount selection for repo agents.
 *
 * By default a repo agent eager-mounts every repo it declares in frontmatter.
 * That is the right behavior for agents pinned to a handful of repos, but it
 * taxes every spawn of an agent pinned to a wide set — each declared repo gets
 * a working-tree clone (and possibly a base-cache fetch) even when the task
 * touches one of them.
 *
 * `selectReposToMount` narrows the spawn to the task's working set: when the
 * task already carries attachment records for the agent (created by the PM's
 * `attach_repos` tool BEFORE the first spawn), only the declared repos among
 * them are mounted — frontmatter acts as the allowlist, attachments select
 * this task's subset. An eager spawn itself records an attachment for every
 * declared repo, so a task that never used `attach_repos` keeps eager-mounting
 * everything, unchanged.
 */

import type { RepoEntry } from '../types/agent.js';

/**
 * Pick which declared repos to mount for this spawn.
 *
 * - No attachment records yet → every declared repo (eager default).
 * - Attachments present → the declared repos among them. Attached repos that
 *   are no longer declared are ignored (frontmatter is the allowlist; a stale
 *   record is harmless, matching the existing removed-from-frontmatter rule).
 * - Attachments present but none of them declared (all stale) → fall back to
 *   eager rather than spawning an agent with zero repos.
 */
export function selectReposToMount(
  declared: readonly RepoEntry[],
  attachedGithubs: readonly string[],
): RepoEntry[] {
  if (attachedGithubs.length === 0) return [...declared];
  const selected = declared.filter((d) => attachedGithubs.includes(d.github));
  return selected.length > 0 ? selected : [...declared];
}
