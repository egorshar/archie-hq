/**
 * Regression test for `captureTaskRequester` (src/connectors/slack/events.ts).
 *
 * SOC2 requires `requested_by` to always name a human, never an agent/bot.
 * The old code captured it from `thread.messages[0]` guarded only by
 * `!thread.rootAuthorWasBot` — which detects ONLY Archie's own bot, not other
 * internal integration bots (bug-tracker/webhook bots) that `fetchSlackThread`
 * deliberately keeps, including as a synthesized thread-root `SlackAuthor`.
 *
 * The fix moves capture to `captureTaskRequester`, called from the Slack event
 * handler with the CONFIRMED triggering human (`event.user`, already resolved
 * to Slack profile info for the external-author check earlier in the handler)
 * — never with anything derived from thread content. This test verifies its
 * guard logic directly: it only ever calls `task.setRequester` with the
 * supplied human identity, and only when one is actually resolved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  initSlackClient: vi.fn(),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  getBotUserId: vi.fn(),
  fetchSlackThread: vi.fn(),
  getBotId: vi.fn(),
  addReaction: vi.fn(),
  setSlackDryRun: vi.fn(),
  getUserInfo: vi.fn(),
  isExternalUser: vi.fn().mockReturnValue(false),
  isChannelShared: vi.fn(),
  postEphemeral: vi.fn(),
  getSlackClient: vi.fn(),
  cleanSlackText: vi.fn((s: string) => s),
}));
vi.mock('../channel-canvas.js', () => ({ ensureChannelCanvas: vi.fn() }));
vi.mock('../title.js', () => ({ setAssistantThreadTitle: vi.fn() }));
vi.mock('../../../tasks/title-generator.js', () => ({ generateTaskTitle: vi.fn() }));
vi.mock('../../../system/shutdown.js', () => ({ getIsShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('../../../system/event-bus.js', () => ({
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitEvent: vi.fn(),
}));
vi.mock('../../../system/workdir.js', () => ({ SESSIONS_DIR: '/tmp/sessions' }));
vi.mock('../../../tasks/task.js', () => ({
  Task: { get: vi.fn(), create: vi.fn() },
  activeTasks: new Map(),
}));
vi.mock('../../../tasks/persistence.js', () => ({
  findTaskByThread: vi.fn(),
  readKnowledgeLog: vi.fn(),
  loadMetadata: vi.fn(),
  appendCliMessage: vi.fn(),
  readEvents: vi.fn(),
}));
vi.mock('../../../system/logger.js', () => ({
  logger: {
    system: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(),
    plain: vi.fn(), server: vi.fn(), slack: vi.fn(),
  },
}));

import { captureTaskRequester } from '../events.js';
import type { Task } from '../../../tasks/task.js';

type FakeTask = { metadata: { requested_by?: unknown }; setRequester: ReturnType<typeof vi.fn> };

function makeFakeTask(requestedBy?: unknown): FakeTask {
  return { metadata: { requested_by: requestedBy }, setRequester: vi.fn() };
}

const humanInfo = { name: 'egor', realName: 'Egor Sharapov', teamId: 'T1' };

describe('captureTaskRequester', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets requested_by from the confirmed human (event.user + resolved profile), not thread content', () => {
    const task = makeFakeTask();
    captureTaskRequester(task as unknown as Task, 'U_HUMAN', humanInfo);
    expect(task.setRequester).toHaveBeenCalledTimes(1);
    expect(task.setRequester).toHaveBeenCalledWith({
      id: 'U_HUMAN',
      username: 'egor',
      realName: 'Egor Sharapov',
      teamId: 'T1',
      isRestricted: undefined,
      isUltraRestricted: undefined,
    });
  });

  it('is a no-op once requested_by is already set (set-once)', () => {
    const task = makeFakeTask({ id: 'U_OTHER', name: 'Someone Else', source: 'slack' });
    captureTaskRequester(task as unknown as Task, 'U_HUMAN', humanInfo);
    expect(task.setRequester).not.toHaveBeenCalled();
  });

  it('never guesses — leaves requested_by unset when the identity failed to resolve (authorInfo undefined)', () => {
    const task = makeFakeTask();
    captureTaskRequester(task as unknown as Task, 'U_HUMAN', undefined);
    expect(task.setRequester).not.toHaveBeenCalled();
  });

  it('never guesses — leaves requested_by unset when there is no event.user', () => {
    const task = makeFakeTask();
    captureTaskRequester(task as unknown as Task, undefined, humanInfo);
    expect(task.setRequester).not.toHaveBeenCalled();
  });
});
