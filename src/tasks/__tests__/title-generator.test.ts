/**
 * Unit tests for generateTaskTitle.
 *
 * Mocks getLlmOneShot() (from system/backends.js) with a stub whose json()
 * is driven per-test, and asserts:
 * - cleaned/truncated output on success
 * - null on failed/thrown one-shot calls, empty results, fully-redacted threads
 * - external authors redacted in transcript before being passed to json()
 *
 * NOTE (Task 17 migration): title-generator.ts previously called the Claude
 * Agent SDK's query() directly and this test mocked that module. It now
 * routes through getLlmOneShot().json() (the LlmOneShot port), so the mock
 * target moved to '../../system/backends.js'. Mocking the SDK module
 * directly no longer works here: getLlmOneShot() pulls in backends.ts's full
 * module graph (GitHub client, workdir, etc.), and mocking one level below
 * (the SDK) left that whole graph to load for real, which failed in this
 * test's sandbox (missing WORKDIR export etc.) — see task-17-report.md for
 * the exact failure. Mocking the port itself is also the right level per the
 * port's contract: title-generator no longer knows or cares that Claude's
 * SDK is behind it.
 *
 * One real behavior change falls out of this: the LlmOneShot.json() port
 * collapses every non-success SDK result subtype into a plain `null` return
 * (see runtime/claude/llm-one-shot.ts's json()) without surfacing *why* it
 * failed, so title-generator can no longer log a distinct "haiku call
 * failed: <subtype>" warning for that path — it now logs a generic
 * "haiku call failed" warning instead, restoring observability without the
 * subtype detail. The two tests below that used to cover "call failed"
 * subtypes are kept (title is still asserted null) and assert the generic
 * warning was logged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlackThread } from '../../types/index.js';

// ---- Mocks ----

const state = vi.hoisted(() => ({
  jsonMock: vi.fn(),
}));

vi.mock('../../system/backends.js', () => ({
  getLlmOneShot: () => ({
    kind: 'claude' as const,
    json: state.jsonMock,
    text: vi.fn(async () => null),
  }),
}));

vi.mock('../../connectors/slack/client.js', () => ({
  isExternalUser: (user: { teamId?: string; isRestricted?: boolean; isUltraRestricted?: boolean }) => {
    if (user.isRestricted || user.isUltraRestricted) return true;
    if (user.teamId && user.teamId !== 'T_HOME') return true;
    return false;
  },
  formatSlackChannelRef: vi.fn(),
  formatSlackChannelDisplay: vi.fn(),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

vi.mock('../../system/event-bus.js', () => ({
  emitEvent: vi.fn(),
  onEvent: vi.fn(),
}));

vi.mock('../../system/workdir.js', () => ({
  SESSIONS_DIR: '/tmp/sessions',
}));

vi.mock('../task.js', () => ({
  activeTasks: new Map(),
}));

import { generateTaskTitle } from '../title-generator.js';
import { logger } from '../../system/logger.js';
const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;

// ---- Helpers ----

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
  };
}

function titleResult(title: string): { title: string } {
  return { title };
}

beforeEach(() => {
  state.jsonMock.mockReset();
  state.jsonMock.mockResolvedValue(null);
  warnSpy.mockClear();
});

// ---- Tests ----

describe('generateTaskTitle', () => {
  it('returns trimmed title on success', async () => {
    state.jsonMock.mockResolvedValue(titleResult('  Fix auth flow on Android  '));
    const title = await generateTaskTitle(makeThread());
    expect(title).toBe('Fix auth flow on Android');
  });

  it('strips surrounding quotes and trailing punctuation', async () => {
    state.jsonMock.mockResolvedValue(titleResult('"Fix auth flow on Android."'));
    const title = await generateTaskTitle(makeThread());
    expect(title).toBe('Fix auth flow on Android');
  });

  it('truncates titles longer than 60 chars', async () => {
    state.jsonMock.mockResolvedValue(titleResult('A'.repeat(120)));
    const title = await generateTaskTitle(makeThread());
    expect(title).not.toBeNull();
    expect(title!.length).toBe(60);
  });

  it('returns null when model returns empty/whitespace', async () => {
    state.jsonMock.mockResolvedValue(titleResult('   '));
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
  });

  it('returns null when the one-shot call fails (error_during_execution)', async () => {
    // LlmOneShot.json() returns null for any non-success SDK result subtype
    // (see runtime/claude/llm-one-shot.ts); it no longer surfaces which
    // subtype failed, but title-generator still logs a generic warn on that
    // path.
    state.jsonMock.mockResolvedValue(null);
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null on error_max_structured_output_retries', async () => {
    state.jsonMock.mockResolvedValue(null);
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
  });

  it('returns null when the one-shot call throws', async () => {
    state.jsonMock.mockRejectedValue(new Error('boom'));
    const title = await generateTaskTitle(makeThread());
    expect(title).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips LLM and returns null when thread is fully redacted', async () => {
    const thread = makeThread({
      shared: true,
      messages: [
        {
          ts: '1.0',
          text: 'external talk',
          user: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' },
        },
      ],
    });
    const title = await generateTaskTitle(thread);
    expect(title).toBeNull();
    expect(state.jsonMock).not.toHaveBeenCalled();
  });

  it('redacts external authors in transcript but keeps internal intact', async () => {
    state.jsonMock.mockResolvedValue(titleResult('Mixed thread title'));
    const thread = makeThread({
      shared: true,
      messages: [
        {
          ts: '1.0',
          text: 'should be redacted',
          user: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' },
        },
        {
          ts: '2.0',
          text: 'internal subject',
          user: { id: 'UINT', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
        },
      ],
    });
    await generateTaskTitle(thread);
    expect(state.jsonMock).toHaveBeenCalled();
    const transcript = state.jsonMock.mock.calls[0][0].prompt as string;
    expect(transcript).toContain('[external]: [redacted: external participant in shared channel]');
    expect(transcript).toContain('[Dana]: internal subject');
    expect(transcript).not.toContain('should be redacted');
  });

  it('includes forwarded-from label for externally-authored attachment from internal author', async () => {
    state.jsonMock.mockResolvedValue(titleResult('Forwarded title'));
    const thread = makeThread({
      shared: false,
      messages: [
        {
          ts: '1.0',
          text: 'fyi',
          user: { id: 'UINT', username: 'me', realName: 'Dana', teamId: 'T_HOME' },
          attachments: [
            {
              text: 'forwarded body',
              author: { id: 'UEXT', username: 'ext', realName: 'External', teamId: 'T_OTHER' },
            },
          ],
        },
      ],
    });
    await generateTaskTitle(thread);
    const transcript = state.jsonMock.mock.calls[0][0].prompt as string;
    expect(transcript).toContain('[forwarded from @<UEXT:External> — external, team T_OTHER]');
    expect(transcript).toContain('forwarded body');
  });

  it('calls getLlmOneShot().json with haiku model and the title JSON schema', async () => {
    state.jsonMock.mockResolvedValue(titleResult('A title'));
    await generateTaskTitle(makeThread());
    expect(state.jsonMock).toHaveBeenCalledTimes(1);
    const args = state.jsonMock.mock.calls[0][0];
    expect(args.model).toBe('haiku');
    expect(args.maxTurns).toBe(2);
    expect(args.jsonSchema).toBeDefined();
  });
});
