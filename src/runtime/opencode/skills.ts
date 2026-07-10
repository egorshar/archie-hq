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
