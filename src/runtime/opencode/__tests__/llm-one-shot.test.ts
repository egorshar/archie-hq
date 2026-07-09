import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock, sessionCreate, sessionPrompt } = vi.hoisted(() => {
  const sessionCreate = vi.fn();
  const sessionPrompt = vi.fn();
  const client = { session: { create: sessionCreate, prompt: sessionPrompt } };
  const createMock = vi.fn(async () => ({ client }));
  return { createMock, sessionCreate, sessionPrompt };
});

vi.mock('@opencode-ai/sdk', () => ({ createOpencode: createMock }));
vi.mock('../../../system/logger.js', () => ({
  logger: { error: vi.fn(), system: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), plain: vi.fn() },
}));

import { OpencodeLlmOneShot } from '../llm-one-shot.js';

const MODEL = 'anthropic/claude-haiku-4-5'; // passthrough — avoids env lookup
const shot = new OpencodeLlmOneShot();

beforeEach(() => {
  sessionCreate.mockReset().mockResolvedValue({ data: { id: 'sess-1' } });
  sessionPrompt.mockReset();
  delete process.env.ARCHIE_OPENCODE_MODEL_HAIKU;
  delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
});

describe('OpencodeLlmOneShot.text', () => {
  it('concatenates text parts and passes model/parts/system', async () => {
    sessionPrompt.mockResolvedValue({
      data: { info: {}, parts: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }, { type: 'tool' }] },
    });
    const out = await shot.text({ prompt: 'hi', model: MODEL, systemPrompt: 'be brief' });
    expect(out).toBe('Hello world');
    const body = sessionPrompt.mock.calls[0][0].body;
    expect(body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' });
    expect(body.parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(body.system).toBe('be brief');
  });

  it('returns null on a message-level error', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: { error: { name: 'ProviderAuthError' } }, parts: [] } });
    expect(await shot.text({ prompt: 'hi', model: MODEL })).toBeNull();
  });

  it('returns null on an HTTP-level error', async () => {
    sessionPrompt.mockResolvedValue({ error: { message: 'boom' } });
    expect(await shot.text({ prompt: 'hi', model: MODEL })).toBeNull();
  });

  it('returns null (no spawn) when the model cannot be resolved', async () => {
    const out = await shot.text({ prompt: 'hi', model: 'haiku' }); // no env, no slash
    expect(out).toBeNull();
    expect(sessionCreate).not.toHaveBeenCalled();
  });
});

describe('OpencodeLlmOneShot.json', () => {
  it('parses a JSON object and instructs the model with the schema', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: '{"title":"X"}' }] } });
    const out = await shot.json({ prompt: 'make a title', model: MODEL, jsonSchema: { type: 'object' } });
    expect(out).toEqual({ title: 'X' });
    const sentText = sessionPrompt.mock.calls[0][0].body.parts[0].text;
    expect(sentText).toContain('JSON Schema');
    expect(sentText).toContain('"type":"object"');
  });

  it('strips code fences before parsing', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: '```json\n{"a":1}\n```' }] } });
    expect(await shot.json({ prompt: 'p', model: MODEL, jsonSchema: {} })).toEqual({ a: 1 });
  });

  it('returns null on unparseable output', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'not json' }] } });
    expect(await shot.json({ prompt: 'p', model: MODEL, jsonSchema: {} })).toBeNull();
  });
});
