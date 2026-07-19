import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../sdk.js', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { claudeLlmOneShot } from '../llm-one-shot.js';

function stream(events: unknown[]) {
  return (async function* () { for (const e of events) yield e; })();
}

beforeEach(() => { queryMock.mockReset(); process.env.ANTHROPIC_API_KEY = 'k'; });

describe('ClaudeLlmOneShot', () => {
  it('text() returns the result string on success', async () => {
    queryMock.mockReturnValue(stream([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
      { type: 'result', subtype: 'success', result: 'final text' },
    ]));
    const out = await claudeLlmOneShot.text({ prompt: 'hi', model: 'sonnet' });
    expect(out).toBe('final text');
  });

  it('json() returns raw structured_output on success', async () => {
    queryMock.mockReturnValue(stream([
      { type: 'result', subtype: 'success', structured_output: { title: 'X' } },
    ]));
    const out = await claudeLlmOneShot.json({ prompt: 'hi', model: 'haiku', jsonSchema: {} });
    expect(out).toEqual({ title: 'X' });
  });

  it('json() returns null on a non-success result', async () => {
    queryMock.mockReturnValue(stream([{ type: 'result', subtype: 'error_max_turns' }]));
    const out = await claudeLlmOneShot.json({ prompt: 'hi', model: 'haiku', jsonSchema: {} });
    expect(out).toBeNull();
  });

  it('passes model, systemPrompt, allowedTools, cwd through to query options', async () => {
    queryMock.mockReturnValue(stream([{ type: 'result', subtype: 'success', result: 'ok' }]));
    await claudeLlmOneShot.text({ prompt: 'p', model: 'haiku', systemPrompt: 'sys', allowedTools: ['Read'], cwd: '/tmp/x' });
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.model).toBe('haiku');
    expect(opts.systemPrompt).toBe('sys');
    expect(opts.allowedTools).toEqual(['Read']);
    expect(opts.cwd).toBe('/tmp/x');
    expect(opts.env.ANTHROPIC_API_KEY).toBe('k');
  });
});
