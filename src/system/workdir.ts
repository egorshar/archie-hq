/**
 * Workdir Bootstrap
 *
 * Central module for resolving all runtime directories and bootstrapping
 * the working directory structure (cloning plugins and repos).
 *
 * Path constants are synchronous and safe for module-level imports.
 * Bootstrap functions are async and must be called from main() at startup.
 */

import { join } from 'path';
import { existsSync, lstatSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

// =============================================================================
// Path constants (synchronous — safe for module-level use anywhere)
// =============================================================================

/** Base working directory. Everything lives under here. */
export const WORKDIR = process.env.ARCHIE_WORKDIR || join(process.cwd(), 'workdir');

/** Plugins directory (cloned from ARCHIE_PLUGINS git URL) */
export const PLUGINS_DIR = join(WORKDIR, 'plugins');

/** Base repos directory (auto-cloned from plugin repo-config.json) */
export const REPOS_DIR = join(WORKDIR, 'repos');

/** Sessions directory (task runtime data) */
export const SESSIONS_DIR = join(WORKDIR, 'sessions');

// =============================================================================
// Bootstrap (async — must be called from main() before plugin/repo loading)
// =============================================================================

/**
 * Bootstrap the workdir:
 * 1. Ensure directory structure exists
 * 2. Clone/pull plugins repo (if ARCHIE_PLUGINS is set)
 *
 * Must be called once at startup before initPlugins().
 */
export async function bootstrapWorkdir(): Promise<void> {
  await mkdir(WORKDIR, { recursive: true });
  await mkdir(REPOS_DIR, { recursive: true });
  await mkdir(SESSIONS_DIR, { recursive: true });

  const pluginsUrl = process.env.ARCHIE_PLUGINS;
  if (pluginsUrl) {
    await cloneOrPull(pluginsUrl, PLUGINS_DIR, 'plugins');
  } else if (!existsSync(PLUGINS_DIR)) {
    throw new Error(
      `Plugins directory not found at ${PLUGINS_DIR}. ` +
      `Set ARCHIE_PLUGINS to a git URL, or manually place plugins in ${PLUGINS_DIR}.`
    );
  }
}

/**
 * Clone repos declared by plugins. Called after plugins are loaded.
 *
 * @param repos - Array of { key, githubRepo } from loaded plugin configs
 */
export async function cloneRepos(
  repos: Array<{ key: string; githubRepo: string }>
): Promise<void> {
  for (const { key, githubRepo } of repos) {
    const repoPath = join(REPOS_DIR, key);
    const repoUrl = githubRepoToUrl(githubRepo);
    await cloneOrFetch(repoUrl, repoPath, key);
  }
}

// =============================================================================
// Git helpers
// =============================================================================

/**
 * Convert "org/repo" to an HTTPS clone URL.
 * HTTPS works with the existing GIT_ASKPASS infrastructure.
 */
function githubRepoToUrl(githubRepo: string): string {
  return `https://github.com/${githubRepo}.git`;
}

/**
 * Clone if missing, git pull --ff-only if exists.
 * Used for plugins (small repo, need working tree up to date).
 */
async function cloneOrPull(url: string, targetDir: string, label: string): Promise<void> {
  if (existsSync(join(targetDir, '.git'))) {
    logger.system(`Pulling latest ${label}...`);
    try {
      await execAsync('git pull --ff-only', { cwd: targetDir });
    } catch (error) {
      logger.warn('workdir', `Failed to pull ${label}, using existing version: ${error}`);
    }
  } else {
    logger.system(`Cloning ${label} from ${url}...`);
    // Remove broken symlinks or non-git directories before cloning
    try {
      lstatSync(targetDir); // throws if nothing exists at path
      await rm(targetDir, { recursive: true, force: true });
    } catch {
      // Path doesn't exist — good, clone will create it
    }
    await execAsync(`git clone "${url}" "${targetDir}"`);
  }
}

/**
 * Clone if missing, git fetch --all if exists.
 * Used for source repos (large, just need refs up to date for worktrees).
 */
async function cloneOrFetch(url: string, targetDir: string, label: string): Promise<void> {
  if (existsSync(join(targetDir, '.git'))) {
    logger.system(`Fetching latest for ${label}...`);
    try {
      await execAsync('git fetch --all', { cwd: targetDir });
    } catch (error) {
      logger.warn('workdir', `Failed to fetch ${label}, using existing refs: ${error}`);
    }
  } else {
    logger.system(`Cloning ${label} from ${url}...`);
    await execAsync(`git clone "${url}" "${targetDir}"`);
  }
}
