/**
 * Host-neutral repo URL + label helpers. Reads REPO_HOST / GITLAB_BASE_URL from
 * the environment directly (NOT via system/backends.ts) so low-level modules
 * (repo-clone, workdir, persistence) can use it without an import cycle. Mirrors
 * each host's cloneUrl() logic. `repoCloneUrl` is added in Task 2.
 */

export function repoHostKind(): 'github' | 'gitlab' {
  return (process.env.REPO_HOST ?? 'github').trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
}

/** Prefix for knowledge-log event destinations, e.g. `github:` / `gitlab:`. */
export function repoEventPrefix(): 'github' | 'gitlab' {
  return repoHostKind();
}
