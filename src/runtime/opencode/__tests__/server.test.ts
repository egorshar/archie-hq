import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

const createOpencode = vi.fn();
vi.mock('@opencode-ai/sdk', () => ({ createOpencode }));

const writeBridgePlugin = vi.fn();
vi.mock('../bridge/plugin-source.js', () => ({ writeBridgePlugin }));

describe('opencode server singleton', () => {
  beforeEach(() => {
    vi.resetModules();
    createOpencode.mockReset();
    writeBridgePlugin.mockReset();
    writeBridgePlugin.mockResolvedValue('/fake/.opencode/plugins/archie-bridge.ts');
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
    expect(writeBridgePlugin).not.toHaveBeenCalled(); // no bridge config → no plugin write
  });

  it('places the bridge plugin under <cwd>/.opencode/plugins before starting the server, when a bridge config is given', async () => {
    const client = { session: {} };
    const callOrder: string[] = [];
    writeBridgePlugin.mockImplementation(async () => {
      callOrder.push('writeBridgePlugin');
      return '/fake/.opencode/plugins/archie-bridge.ts';
    });
    createOpencode.mockImplementation(async () => {
      callOrder.push('createOpencode');
      return { client, server: {} };
    });
    const { getOpencodeClient } = await import('../server.js');
    const result = await getOpencodeClient({ url: 'http://127.0.0.1:12345', token: 'tok-abc' });
    expect(result).toBe(client);
    expect(writeBridgePlugin).toHaveBeenCalledWith(
      join(process.cwd(), '.opencode', 'plugins'),
      'http://127.0.0.1:12345',
      'tok-abc',
    );
    expect(callOrder).toEqual(['writeBridgePlugin', 'createOpencode']);
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
