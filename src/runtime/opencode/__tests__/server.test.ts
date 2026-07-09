import { describe, it, expect, vi, beforeEach } from 'vitest';

const createOpencode = vi.fn();
vi.mock('@opencode-ai/sdk', () => ({ createOpencode }));

describe('opencode server singleton', () => {
  beforeEach(() => {
    vi.resetModules();
    createOpencode.mockReset();
  });

  it('starts the embedded server once and reuses the client', async () => {
    const client = { session: {} };
    createOpencode.mockResolvedValue({ client, server: {} });
    const { getOpencodeClient } = await import('../server.js');
    const a = await getOpencodeClient();
    const b = await getOpencodeClient();
    expect(a).toBe(client);
    expect(b).toBe(client);
    expect(createOpencode).toHaveBeenCalledTimes(1);
    expect(createOpencode).toHaveBeenCalledWith({ port: 0 });
  });

  it('concatPromptText joins text parts and returns null when empty', async () => {
    createOpencode.mockResolvedValue({ client: {}, server: {} });
    const { concatPromptText } = await import('../server.js');
    expect(concatPromptText({ data: { parts: [
      { type: 'text', text: 'he' }, { type: 'tool', text: 'x' }, { type: 'text', text: 'llo' },
    ] } })).toBe('hello');
    expect(concatPromptText({ data: { parts: [] } })).toBeNull();
    expect(concatPromptText({ data: { info: { error: { name: 'X' } } } })).toBeNull();
  });
});
