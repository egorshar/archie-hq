/**
 * Symlink-based skill directory assembly, shared by the Claude spawn path
 * (`spawn.ts`, per-agent `.claude/skills`) and the opencode runtime (staging the
 * union of skills at the embedded server's working directory). Kept
 * dependency-free (fs + path only) so the opencode runtime can import it without
 * pulling in `spawn.ts` → `backends` → the runtime itself (an import cycle).
 */
import { rm, mkdir, readdir, stat, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { safePathSegment } from '../system/path-safety.js';

/**
 * (Re)build a skills dir as symlinks into the given source dirs, sources first
 * so an earlier source shadows a later one of the same name.
 *
 * Rebuilt from scratch each call. A prior run — or a DIFFERENT process sharing
 * this workdir (e.g. a container whose absolute `/workdir/...` paths don't
 * resolve on the host) — can leave symlinks here. The old guard used
 * `existsSync(target)`, which FOLLOWS the link, so a DANGLING link returned
 * false, slipped the guard, and made `symlink()` throw EEXIST — and that
 * rejection, uncaught in the recovery re-spawn path, crashed the daemon
 * (a cross-instance-workdir incident). Clearing the dir first heals any
 * stale/dangling links; within the fresh build the first source to claim a name
 * wins, which preserves source ordering (e.g. plugin-shadows-core).
 */
export async function linkAgentSkills(agentSkillsDir: string, skillSources: string[]): Promise<void> {
  await rm(agentSkillsDir, { recursive: true, force: true });
  await mkdir(agentSkillsDir, { recursive: true });
  for (const skillsPath of skillSources) {
    for (const skillEntry of await readdir(skillsPath, { withFileTypes: true })) {
      const entryName = safePathSegment(skillEntry.name, 'skill name');
      const entryPath = join(skillsPath, entryName);
      // Mount real skill dirs AND symlinks that resolve to a dir. A skill can be
      // vendored as a git submodule and exposed via a symlink (e.g. the
      // data-analytics data-context); readdir's Dirent.isDirectory() is false
      // for a symlink, so stat-follow to classify it. A dangling link is skipped.
      let isDir = skillEntry.isDirectory();
      if (!isDir && skillEntry.isSymbolicLink()) {
        isDir = await stat(entryPath).then((s) => s.isDirectory()).catch(() => false);
      }
      if (!isDir) continue;
      const target = join(agentSkillsDir, entryName);
      // The dir was just cleared, so any link present here was created earlier
      // in THIS build — first source to claim a name wins.
      if (!existsSync(target)) {
        await symlink(entryPath, target);
      }
    }
  }
}
