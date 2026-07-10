/**
 * applyBotGitIdentityEnv forces the git committer/author env for the opencode
 * agent's bash `git commit` (env beats local + global config). Regression for
 * the 2026-07-10 push rejection: the agent committed with the host user's
 * personal identity, so GitLab's "committer must be a verified email of the
 * token account" push rule declined the first push.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyBotGitIdentityEnv } from '../server.js';

const SAVED = ['REPO_HOST', 'GITLAB_BOT_NAME', 'GITLAB_BOT_EMAIL',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
  'GITHUB_APP_ID', 'GITHUB_APP_SLUG'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('applyBotGitIdentityEnv', () => {
  it('forces GIT_COMMITTER_* and GIT_AUTHOR_* to the GitLab bot identity', () => {
    process.env.REPO_HOST = 'gitlab';
    process.env.GITLAB_BOT_NAME = 'archie-bot';
    process.env.GITLAB_BOT_EMAIL = 'project_1_bot_abc@noreply.gitlab.example';
    // Simulate a host user's personal identity leaking via env.
    process.env.GIT_COMMITTER_EMAIL = 'human@personal.example';

    applyBotGitIdentityEnv();

    expect(process.env.GIT_COMMITTER_NAME).toBe('archie-bot');
    expect(process.env.GIT_COMMITTER_EMAIL).toBe('project_1_bot_abc@noreply.gitlab.example');
    expect(process.env.GIT_AUTHOR_NAME).toBe('archie-bot');
    expect(process.env.GIT_AUTHOR_EMAIL).toBe('project_1_bot_abc@noreply.gitlab.example');
  });

  it('is a no-op when no bot identity is configured (leaves env untouched)', () => {
    process.env.REPO_HOST = 'gitlab';
    delete process.env.GITLAB_BOT_NAME;
    delete process.env.GITLAB_BOT_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;

    applyBotGitIdentityEnv();

    expect(process.env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });
});
