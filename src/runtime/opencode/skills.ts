/**
 * Stage the union of every agent's skills into the embedded opencode server's
 * `.opencode/skills` directory, so the shared server's native `skill` tool
 * exposes all domain skills to every agent.
 *
 * This is GLOBAL, not per-agent: opencode discovers skills by the serve
 * process's working directory, and Archie runs ONE shared embedded server, so
 * every agent sees every staged skill (unlike the Claude runtime, which scopes
 * skills per-agent via separate workspaces). Which skill an agent should use is
 * steered by its prompt, not by which skills are visible. See
 * docs/guides/opencode-setup.md.
 */
import { mkdir, readFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import type { AgentDef } from '../../types/agent.js';
import { getAllAgentDefs } from '../../agents/registry.js';
import { linkAgentSkills } from '../../agents/skill-linking.js';

/**
 * Link every distinct plugin/core skill source declared by any agent into
 * `skillsDir`. Returns the staged skill-source count (for logging). Reuses the
 * dependency-free `linkAgentSkills` (clears + rebuilds; first source wins on a
 * name collision).
 */
export async function stageOpencodeSkills(skillsDir: string): Promise<number> {
  const sources = Array.from(
    new Set(
      getAllAgentDefs()
        .flatMap((d) => [d.skillsPath, d.coreSkillsPath])
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    ),
  );
  await linkAgentSkills(skillsDir, sources);
  return sources.length;
}

/**
 * Stage ONE agent's skills into a per-child skills dir (P3a §4): only
 * `def.skillsPath` + `def.coreSkillsPath`, plugin source first so it shadows a
 * core skill of the same name (same ordering the Claude spawn path uses).
 * Returns the staged source count for logging. Clear-and-rebuild via
 * linkAgentSkills, so idempotent.
 */
export async function stageAgentSkills(def: AgentDef, skillsDir: string): Promise<number> {
  const sources = [def.skillsPath, def.coreSkillsPath].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  await linkAgentSkills(skillsDir, sources);
  return sources.length;
}

/**
 * Keep a clone-hosted `.opencode/` (staged skills + generated bridge plugin,
 * which embeds a live bearer token) out of any commit by appending it to the
 * clone's `.git/info/exclude` (repo-local, never touches tracked files —
 * same mechanism planned for ai-context outputs). Idempotent.
 */
export async function excludeOpencodeFromGit(cloneRoot: string): Promise<void> {
  const excludePath = join(cloneRoot, '.git', 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  let current = '';
  try {
    current = await readFile(excludePath, 'utf8');
  } catch {
    current = ''; // no exclude file yet — created by the append below
  }
  if (current.split('\n').includes('.opencode/')) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(excludePath, `${sep}.opencode/\n`);
}
