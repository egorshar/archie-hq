/**
 * Per-agent skill staging for the opencode runtime (P3a §4). Each agent's serve
 * child stages ONLY that agent's skills (skillsPath + coreSkillsPath) into its
 * own cwd's `.opencode/skills` — per-agent scoping falls out of the per-agent
 * serve topology (parity with the Claude runtime's per-agent workspaces). For
 * repo agents the cwd is the clone, so the staged dir is kept out of commits
 * via `.git/info/exclude` (excludeOpencodeFromGit).
 */
import { mkdir, readFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import type { AgentDef } from '../../types/agent.js';
import { linkAgentSkills } from '../../agents/skill-linking.js';

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
