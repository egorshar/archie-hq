import { describe, it, expect, vi, beforeEach } from 'vitest';

const startBridgeServer = vi.fn();
vi.mock('../bridge/server.js', () => ({ startBridgeServer }));

function makeBridgeHandle(overrides: Partial<{ url: string; token: string; close: () => Promise<void> }> = {}) {
  return {
    url: overrides.url ?? 'http://127.0.0.1:9999',
    token: overrides.token ?? 'tok-xyz',
    mintChildToken: vi.fn(),
    revokeChildToken: vi.fn(),
    close: overrides.close ?? vi.fn(async () => {}),
  };
}

describe('concatPromptText', () => {
  it('joins text parts and returns null when empty', async () => {
    const { concatPromptText } = await import('../server.js');
    expect(concatPromptText({ data: { parts: [
      { type: 'text', text: 'he' }, { type: 'tool', text: 'x' }, { type: 'text', text: 'llo' },
    ] } })).toBe('hello');
    expect(concatPromptText({ data: { parts: [] } })).toBeNull();
    expect(concatPromptText({ data: { info: { error: { name: 'X' } } } })).toBeNull();
  });
});

describe('getBridge singleton', () => {
  beforeEach(() => {
    vi.resetModules();
    startBridgeServer.mockReset();
    startBridgeServer.mockImplementation(async () => makeBridgeHandle());
  });

  it('starts the bridge once and reuses the handle for concurrent callers', async () => {
    const { getBridge, closeBridge } = await import('../server.js');
    const [a, b] = await Promise.all([getBridge(), getBridge()]);
    expect(a).toBe(b);
    expect(startBridgeServer).toHaveBeenCalledTimes(1);
    await closeBridge();
  });

  it('closeBridge closes the handle and clears the singleton so a later getBridge re-boots', async () => {
    const { getBridge, closeBridge } = await import('../server.js');
    const first = await getBridge();
    await closeBridge();
    expect(first.close).toHaveBeenCalledTimes(1);
    await getBridge();
    expect(startBridgeServer).toHaveBeenCalledTimes(2);
    await closeBridge();
  });

  it('a failed bridge start clears the promise so the next call retries', async () => {
    const { getBridge, closeBridge } = await import('../server.js');
    startBridgeServer.mockRejectedValueOnce(new Error('EADDRINUSE'));
    await expect(getBridge()).rejects.toThrow('EADDRINUSE');
    await expect(getBridge()).resolves.toBeTruthy();
    await closeBridge();
  });

  it('closeBridge is a no-op before the bridge ever started', async () => {
    const { closeBridge } = await import('../server.js');
    await expect(closeBridge()).resolves.toBeUndefined();
  });
});
