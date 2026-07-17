/**
 * Regression test for SOC2 `requested_by` attribution (Task 5 / B1 review).
 *
 * Bug: `Task.append(thread)` used to capture `requested_by` from
 * `thread.messages[0].user`, guarded only by `!thread.rootAuthorWasBot` — which
 * detects ONLY Archie's own bot. `fetchSlackThread` deliberately keeps OTHER
 * internal integration bots (bug-tracker/webhook bots) in the thread, including
 * as the root message, and synthesizes a `SlackAuthor` for them (id/name =
 * bot id/name). So a thread started by an integration bot, later @mentioned by
 * a human, permanently set `requested_by` to the BOT — violating "never an
 * agent/bot".
 *
 * Fix: `append()` no longer touches `requested_by` at all. A new
 * `Task.setRequester(author)` method (set-once, via `captureRequester`) is the
 * only way to populate it, and the Slack event handler (see
 * `src/connectors/slack/events.ts` — `captureTaskRequester`) calls it with the
 * CONFIRMED triggering human (`event.user`, resolved to a `SlackAuthor`),
 * never with thread content.
 *
 * This test drives the real `Task.append`/`Task.setRequester` against a
 * bot-authored-root thread to prove the exact bug scenario no longer
 * misattributes to the bot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
}));

import { Task, activeTasks } from '../task.js';
import type { TaskMetadata, SlackThread, SlackAuthor } from '../../types/task.js';
import type { AgentDef } from '../../types/agent.js';

const TaskCtor = Task as unknown as new (
  taskId: string,
  metadata: TaskMetadata,
  team: AgentDef[],
) => Task;

const TASK_ID = 'task-20260717-1000-soc2test';

function metadata(): TaskMetadata {
  return {
    task_id: TASK_ID,
    task_owner: null,
    participants: [],
    channels: {},
    default_channel: null,
    agent_sessions: {},
    repositories: {},
    status: 'in_progress',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  };
}

const pmDef = () =>
  ({ id: 'pm-agent', key: 'pm', role: 'PM', expertise: '', isPm: true, pluginName: 'pm' }) as AgentDef;

// The synthesized author fetchSlackThread produces for a kept internal
// integration bot (e.g. a bug-tracker webhook) — id/name = the bot's own id/name.
const botAuthor: SlackAuthor = {
  id: 'B0BUGBOT',
  username: 'bugtracker',
  realName: 'Bug Tracker',
};

const humanAuthor: SlackAuthor = {
  id: 'U_HUMAN',
  username: 'egor',
  realName: 'Egor Sharapov',
};

function botRootThenHumanMentionThread(): SlackThread {
  return {
    threadId: '1000.000001',
    channel: { id: 'C123', name: 'eng-alerts' },
    shared: false,
    // rootAuthorWasBot is only true for OUR bot — a different (internal)
    // integration bot's root is kept but reported as false here, which is
    // exactly the gap the old guard (`!thread.rootAuthorWasBot`) missed.
    rootAuthorWasBot: false,
    messages: [
      { user: botAuthor, text: 'New issue filed: prod 500s spiking', ts: '1000.000001' },
      { user: humanAuthor, text: '<@ARCHIEBOT> can you take a look?', ts: '1000.000002' },
    ],
    currentMessageTs: '1000.000002',
  };
}

describe('requested_by attribution — bot-authored thread root + human @mention', () => {
  beforeEach(() => {
    activeTasks.delete(TASK_ID);
  });

  afterEach(() => {
    activeTasks.delete(TASK_ID);
  });

  it('append() no longer captures requested_by from thread content at all', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), [pmDef()]);
    await task.append(botRootThenHumanMentionThread());
    // The old code would have set this to the bot (thread.messages[0].user).
    // The fix removes that capture entirely — append() must leave it unset.
    expect(task.metadata.requested_by).toBeUndefined();
  });

  it('setRequester() (fed the confirmed triggering human) sets requested_by to the HUMAN, never the bot', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), [pmDef()]);
    await task.append(botRootThenHumanMentionThread());
    expect(task.metadata.requested_by).toBeUndefined();

    // Mirrors events.ts: the event handler resolves event.user (the confirmed
    // human who @mentioned Archie) and calls setRequester with it — never with
    // anything derived from the thread.
    task.setRequester(humanAuthor);

    expect(task.metadata.requested_by).toEqual({
      id: 'U_HUMAN',
      name: 'Egor Sharapov',
      source: 'slack',
    });
  });

  it('is set-once — a later call (even with a bot identity) never overwrites the human', async () => {
    const task = new TaskCtor(TASK_ID, metadata(), [pmDef()]);
    task.setRequester(humanAuthor);
    task.setRequester(botAuthor); // should never happen in practice, but must be inert if it did
    expect(task.metadata.requested_by).toEqual({
      id: 'U_HUMAN',
      name: 'Egor Sharapov',
      source: 'slack',
    });
  });
});
