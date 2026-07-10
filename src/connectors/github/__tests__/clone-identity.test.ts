/**
 * Regression: `setupSharedClone` must set the clone's local committer identity
 * to the current bot BEFORE returning, so it is a precondition of the clone
 * existing — not a later, separate step.
 *
 * The opencode repo agent commits via raw `bash git commit`. When identity was
 * configured only afterwards (spawn.ts prepareAgentContext), a commit could land
 * first and fall back to the host's global ~/.gitconfig, whose email is not a
 * verified email of the GitLab token account — so the push was declined by the
 * pre-receive hook (2026-07-10 dev-metrics MR run). These tests use a real temp
 * git repo and assert a commit made immediately after clone creation carries the
 * bot committer, not the host identity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSharedClone } from '../repo-clone.js';

vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const BOT = { name: 'archie-bot', email: 'project_1_bot_abc@noreply.gitlab.example' };
const HOST = { name: 'Human Dev', email: 'human@personal.example' };
const SAVED = ['REPO_HOST', 'GITLAB_BOT_NAME', 'GITLAB_BOT_EMAIL'];

let saved: Record<string, string | undefined>;
let base: string;
let cloneParent: string;

const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' });

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  process.env.REPO_HOST = 'gitlab';
  process.env.GITLAB_BOT_NAME = BOT.name;
  process.env.GITLAB_BOT_EMAIL = BOT.email;

  base = mkdtempSync(join(tmpdir(), 'archie-base-'));
  cloneParent = mkdtempSync(join(tmpdir(), 'archie-clone-'));

  // A base repo whose ONLY configured identity is a host/human one — if the
  // clone doesn't set its own, a commit there would fall back to this (or the
  // test runner's global config), never the bot.
  run('git init -q -b main', base);
  run(`git config user.name "${HOST.name}"`, base);
  run(`git config user.email "${HOST.email}"`, base);
  writeFileSync(join(base, 'README.md'), 'hello\n');
  run('git add README.md', base);
  run('git -c commit.gpgsign=false commit -q -m init', base);
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(cloneParent, { recursive: true, force: true });
});

describe('setupSharedClone git identity', () => {
  it('sets the clone local committer identity to the bot at creation time', async () => {
    const clonePath = join(cloneParent, 'clone');
    await setupSharedClone(clonePath, base, { type: 'base' }, 'main');

    const email = run('git config --local --get user.email', clonePath).toString().trim();
    const name = run('git config --local --get user.name', clonePath).toString().trim();
    expect(email).toBe(BOT.email);
    expect(name).toBe(BOT.name);
  });

  it('a commit in the fresh clone uses the bot committer, not the host identity', async () => {
    const clonePath = join(cloneParent, 'clone2');
    await setupSharedClone(clonePath, base, { type: 'new_branch', name: 'archie/x' }, 'main');

    // Reproduce the agent's raw bash commit immediately after clone creation.
    writeFileSync(join(clonePath, 'README.md'), 'hello\nchange\n');
    run('git add README.md', clonePath);
    run('git -c commit.gpgsign=false commit -q -m change', clonePath);

    const committer = run("git log -1 --format=%ce", clonePath).toString().trim();
    expect(committer).toBe(BOT.email);
    expect(committer).not.toBe(HOST.email);
  });
});
