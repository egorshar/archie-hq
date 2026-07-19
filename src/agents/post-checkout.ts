/**
 * Repo post-checkout hook (operator-defined command, per-repo opt-in).
 *
 * Runs the operator-controlled command in `ARCHIE_REPO_POSTCHECKOUT` inside a
 * repo clone right after checkout, for repos whose frontmatter opts in
 * (`RepoEntry.postCheckout`). The motivating use is to write a `.npmrc` and run
 * `npx ai-context sync` so the clone carries the right per-harness context
 * files (AGENTS.md / CLAUDE.md / …) before the agent works in it — hence it
 * runs for both the Claude and opencode runtimes (this is the shared launch
 * path). The operator's command can append its own outputs to the clone's
 * `.git/info/exclude` if they must stay out of commits.
 *
 * SECURITY — deliberately ENV-driven, NOT frontmatter-driven. The command runs
 * in the ORCHESTRATOR process, which holds every secret (the OAuth vault master
 * key, the git-host token, the GitHub App private key, Slack + model-provider
 * keys). So WHAT runs must be operator-controlled (an env var set at deploy);
 * plugin frontmatter supplies only a per-repo BOOLEAN — it chooses WHICH repos
 * the operator's command runs for, never the command string. This preserves the
 * codebase's plugins-cannot-widen-trust posture: a hot-reloaded plugins push
 * cannot introduce orchestrator code execution.
 *
 * Best-effort: an unset command is a no-op; a failing or timing-out command is
 * warn-logged and never blocks the agent spawn.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../system/logger.js';

const execAsync = promisify(exec);

/** Generous cap — `npx ai-context sync` may fetch a package + hit the network. */
const POST_CHECKOUT_TIMEOUT_MS = 120_000;

export async function runRepoPostCheckout(opts: {
  clonePath: string;
  github: string;
  editAllowed: boolean;
}): Promise<void> {
  const command = process.env.ARCHIE_REPO_POSTCHECKOUT?.trim();
  if (!command) return; // operator hasn't configured a hook → no-op

  try {
    await execAsync(command, {
      cwd: opts.clonePath,
      // Runs with the orchestrator env (the operator's command may need a token
      // to write .npmrc, etc.), plus two context vars so it can branch per repo.
      env: { ...process.env, ARCHIE_POSTCHECKOUT_REPO: opts.github, ARCHIE_POSTCHECKOUT_EDIT_MODE: opts.editAllowed ? '1' : '0' },
      timeout: POST_CHECKOUT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    logger.system(`repo post-checkout hook ran for ${opts.github} (${opts.clonePath})`);
  } catch (err) {
    logger.warn('agent', `repo post-checkout hook failed for ${opts.github} (agent continues): ${err instanceof Error ? err.message : String(err)}`);
  }
}
