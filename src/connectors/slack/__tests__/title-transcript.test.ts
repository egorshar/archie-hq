import { describe, it, expect, vi } from 'vitest';
import type { SlackThread } from '../../../types/index.js';

// `buildSlackTitleTranscript` imports renderMessageForContext from
// tasks/persistence.js, which pulls in the workdir/event-bus/task module graph.
// Mock the leaves so the module loads in the test sandbox (mirrors the mock set
// the prior title-generator test used for the same reason).
vi.mock('../client.js', () => ({
  isExternalUser: (user: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) => {
    if (user.isRestricted || user.isUltraRestricted) return true;
    if (user.teamId && user.teamId !== 'T_HOME') return true;
    return false;
  },
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../../system/workdir.js', () => ({
  SESSIONS_DIR: '/tmp/sessions',
}));

vi.mock('../../../tasks/task.js', () => ({
  activeTasks: new Map(),
}));

import { buildSlackTitleTranscript } from '../title-transcript.js';

function makeThread(overrides?: Partial<SlackThread>): SlackThread {
  return {
    threadId: '1.0',
    channel: { id: 'D1', name: 'DM' },
    shared: false,
    currentMessageTs: '1.0',
    messages: [
      {
        ts: '1.0',
        text: 'hello, can you help fix the broken auth flow on Android',
        user: { id: 'U1', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
      },
    ],
    ...overrides,
  } as SlackThread;
}

describe('buildSlackTitleTranscript', () => {
  it('marks internal-only thread as usable', () => {
    const { transcript, hasUsableContent } = buildSlackTitleTranscript(makeThread());
    expect(hasUsableContent).toBe(true);
    expect(transcript).toContain('[Dana]: hello');
  });

  it('reports no usable content when the thread is fully redacted', () => {
    const { hasUsableContent } = buildSlackTitleTranscript(makeThread({
      shared: true,
      messages: [
        { ts: '1.0', text: 'external talk', user: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' } },
      ],
    }));
    expect(hasUsableContent).toBe(false);
  });

  it('redacts external authors but keeps internal intact', () => {
    const { transcript } = buildSlackTitleTranscript(makeThread({
      shared: true,
      messages: [
        { ts: '1.0', text: 'should be redacted', user: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' } },
        { ts: '2.0', text: 'internal subject', user: { id: 'UINT', username: 'me', realName: 'Dana', teamId: 'T_HOME' } },
      ],
    }));
    expect(transcript).toContain('[external]: [redacted: external participant in shared channel]');
    expect(transcript).toContain('[Dana]: internal subject');
    expect(transcript).not.toContain('should be redacted');
  });

  it('includes forwarded-from label for an externally-authored attachment from an internal author', () => {
    const { transcript } = buildSlackTitleTranscript(makeThread({
      shared: false,
      messages: [
        {
          ts: '1.0',
          text: 'fyi',
          user: { id: 'UINT', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
          attachments: [
            { text: 'forwarded body', author: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' } },
          ],
        },
      ],
    }));
    expect(transcript).toContain('[forwarded from @<UEXT:External> — external, team T_OTHER]');
    expect(transcript).toContain('forwarded body');
  });
});
