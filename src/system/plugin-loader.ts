/**
 * Plugin Loader
 *
 * Scans the plugins directory and loads plugin metadata.
 * Each plugin is a directory under plugins/ that may contain:
 *   - repo-config.json  — repo agent infrastructure configs
 *   - agents/*.md       — agent prompts with frontmatter (role, expertise)
 *   - pm/               — PM skill directories (each subdir has SKILL.md)
 *   - .claude-plugin/plugin.json — optional plugin metadata
 *
 * Consumers (repo-configs, task-manager) pull what they need from loaded plugins.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export const PLUGINS_DIR = join(process.cwd(), process.env.ARCHIE_PLUGINS_DIR || 'plugins');

export interface PluginRepoConfig {
  githubRepo: string;
  baseBranch?: string;
  repoPath?: string;
  prompt: string;
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  /** Parsed repo-config.json if present — keyed by agent key (e.g. "backend") */
  repoConfigs: Record<string, PluginRepoConfig> | null;
  /** Absolute path to pm/ skills directory, if it exists */
  pmSkillsDir: string | null;
  /** Names of PM skill subdirectories (e.g. ["engineering", "engineering-pr"]) */
  pmSkillNames: string[];
}

/**
 * Scan plugins directory and load all plugins.
 * A plugin is any subdirectory of PLUGINS_DIR.
 * Called once at startup (sync reads are fine).
 */
function scanPlugins(): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];

  if (!existsSync(PLUGINS_DIR)) {
    return plugins;
  }

  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginName = entry.name;
    const pluginDir = join(PLUGINS_DIR, pluginName);

    // Load repo-config.json if present
    let repoConfigs: Record<string, PluginRepoConfig> | null = null;
    const repoConfigPath = join(pluginDir, 'repo-config.json');
    if (existsSync(repoConfigPath)) {
      repoConfigs = JSON.parse(readFileSync(repoConfigPath, 'utf-8'));
    }

    // Check for pm/ skills directory and enumerate skill names
    const pmSkillsDir = join(pluginDir, 'pm');
    const hasPmSkills = existsSync(pmSkillsDir);
    const pmSkillNames: string[] = [];
    if (hasPmSkills) {
      for (const skillEntry of readdirSync(pmSkillsDir, { withFileTypes: true })) {
        if (skillEntry.isDirectory()) {
          pmSkillNames.push(skillEntry.name);
        }
      }
    }

    plugins.push({
      name: pluginName,
      dir: pluginDir,
      repoConfigs,
      pmSkillsDir: hasPmSkills ? pmSkillsDir : null,
      pmSkillNames,
    });
  }

  return plugins;
}

// Load at module initialization
const loadedPlugins = scanPlugins();

/**
 * Get all loaded plugins
 */
export function getPlugins(): LoadedPlugin[] {
  return loadedPlugins;
}

/**
 * Get plugins that have repo agent configs
 */
export function getPluginsWithRepoConfigs(): LoadedPlugin[] {
  return loadedPlugins.filter((p) => p.repoConfigs !== null);
}

/**
 * Get plugins that have PM skills
 */
export function getPluginsWithPmSkills(): LoadedPlugin[] {
  return loadedPlugins.filter((p) => p.pmSkillsDir !== null);
}
