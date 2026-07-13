/**
 * Unit tests for generateTitle + applyGeneratedTitle.
 * Mocks getLlmOneShot() (system/backends.js) with a json() stub driven per-test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ jsonMock: vi.fn() }));

vi.mock('../../system/backends.js', () => ({
  getLlmOneShot: () => ({ kind: 'claude' as const, json: state.jsonMock, text: vi.fn(async () => null) }),
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

import { generateTitle, applyGeneratedTitle } from '../title-generator.js';
import { logger } from '../../system/logger.js';
const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;

function titleResult(title: string): { title: string } {
  return { title };
}

beforeEach(() => {
  state.jsonMock.mockReset();
  state.jsonMock.mockResolvedValue(null);
  warnSpy.mockClear();
});

describe('generateTitle', () => {
  it('returns trimmed title on success', async () => {
    state.jsonMock.mockResolvedValue(titleResult('  Fix auth flow on Android  '));
    expect(await generateTitle('help fix the broken auth flow')).toBe('Fix auth flow on Android');
  });

  it('strips surrounding quotes and trailing punctuation', async () => {
    state.jsonMock.mockResolvedValue(titleResult('"Fix auth flow on Android."'));
    expect(await generateTitle('x')).toBe('Fix auth flow on Android');
  });

  it('truncates titles longer than 60 chars', async () => {
    state.jsonMock.mockResolvedValue(titleResult('A'.repeat(120)));
    const title = await generateTitle('x');
    expect(title!.length).toBe(60);
  });

  it('returns null when model returns empty/whitespace', async () => {
    state.jsonMock.mockResolvedValue(titleResult('   '));
    expect(await generateTitle('x')).toBeNull();
  });

  it('returns null and skips the one-shot on a blank transcript', async () => {
    expect(await generateTitle('   ')).toBeNull();
    expect(state.jsonMock).not.toHaveBeenCalled();
  });

  it('returns null and warns when the one-shot returns null', async () => {
    state.jsonMock.mockResolvedValue(null);
    expect(await generateTitle('x')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null and warns when the one-shot throws', async () => {
    state.jsonMock.mockRejectedValue(new Error('boom'));
    expect(await generateTitle('x')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('calls getLlmOneShot().json with haiku model and the title JSON schema', async () => {
    state.jsonMock.mockResolvedValue(titleResult('A title'));
    await generateTitle('x');
    const args = state.jsonMock.mock.calls[0][0];
    expect(args.model).toBe('haiku');
    expect(args.maxTurns).toBe(2);
    expect(args.jsonSchema).toBeDefined();
  });
});

describe('applyGeneratedTitle', () => {
  function fakeTask() {
    return { taskId: 't1', metadata: {} as { title?: string }, debouncedSave: vi.fn() };
  }

  it('sets metadata.title + saves and returns the title on success', async () => {
    state.jsonMock.mockResolvedValue(titleResult('Concise title'));
    const task = fakeTask();
    const title = await applyGeneratedTitle(task as any, 'do the thing');
    expect(title).toBe('Concise title');
    expect(task.metadata.title).toBe('Concise title');
    expect(task.debouncedSave).toHaveBeenCalledOnce();
  });

  it('leaves metadata untouched and returns null when generation fails', async () => {
    state.jsonMock.mockResolvedValue(null);
    const task = fakeTask();
    const title = await applyGeneratedTitle(task as any, 'do the thing');
    expect(title).toBeNull();
    expect(task.metadata.title).toBeUndefined();
    expect(task.debouncedSave).not.toHaveBeenCalled();
  });
});
