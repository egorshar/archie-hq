import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

const createOpencode = vi.fn();
vi.mock('@opencode-ai/sdk', () => ({ createOpencode }));

const writeBridgePlugin = vi.fn();
vi.mock('../bridge/plugin-source.js', () => ({ writeBridgePlugin }));

const startBridgeServer = vi.fn();
vi.mock('../bridge/server.js', () => ({ startBridgeServer }));

const resolveOpencodeModel = vi.fn();
vi.mock('../model.js', () => ({ resolveOpencodeModel }));

// Mock the MCP-config builder so the createOpencode call-args assertion is
// hermetic: it reflects this mock, NOT ambient disk/vault state. (The real
// buildOpencodeMcpConfig reads workdir/plugins/.mcp.json and the OAuth vault,
// so its output varies by ARCHIE_SECRETS_KEY / installed plugins — unsuitable
// for a deterministic call-args assertion.)
vi.mock('../mcp-config.js', () => ({ buildOpencodeMcpConfig: vi.fn(async () => ({})) }));

function makeBridgeHandle(overrides: Partial<{ url: string; token: string; close: () => Promise<void> }> = {}) {
  return {
    url: overrides.url ?? 'http://127.0.0.1:9999',
    token: overrides.token ?? 'tok-xyz',
    close: overrides.close ?? vi.fn(async () => {}),
  };
}

describe('opencode server singleton', () => {
  beforeEach(() => {
    vi.resetModules();
    createOpencode.mockReset();
    writeBridgePlugin.mockReset();
    startBridgeServer.mockReset();
    resolveOpencodeModel.mockReset();

    writeBridgePlugin.mockResolvedValue('/fake/.opencode/plugins/archie-bridge.ts');
    startBridgeServer.mockResolvedValue(makeBridgeHandle());
    resolveOpencodeModel.mockReturnValue({ providerID: 'anthropic', modelID: 'opus' });
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
    expect(startBridgeServer).toHaveBeenCalledTimes(1);
  });

  it('ALWAYS wires in the bridge + config.model + config.permission, regardless of which caller boots the server first', async () => {
    const client = { session: {} };
    createOpencode.mockResolvedValue({ client, server: {} });
    const { getOpencodeClient, sharedRegistry } = await import('../server.js');

    // Simulates the one-shot LLM path calling with no arguments — no caller
    // opts in or out of the bridge; the server always starts with it.
    const result = await getOpencodeClient();

    expect(result).toBe(client);
    expect(startBridgeServer).toHaveBeenCalledWith(sharedRegistry);
    expect(writeBridgePlugin).toHaveBeenCalledWith(
      join(process.cwd(), '.opencode', 'plugins'),
      'http://127.0.0.1:9999',
      'tok-xyz',
    );
    expect(resolveOpencodeModel).toHaveBeenCalledWith('default');
    expect(createOpencode).toHaveBeenCalledWith({
      port: 0,
      config: {
        model: 'anthropic/opus',
        permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
        mcp: {},
      },
    });
  });

  it('starts the bridge and writes the plugin before booting createOpencode', async () => {
    const client = { session: {} };
    const callOrder: string[] = [];
    startBridgeServer.mockImplementation(async () => {
      callOrder.push('startBridgeServer');
      return makeBridgeHandle();
    });
    writeBridgePlugin.mockImplementation(async (...args: unknown[]) => {
      callOrder.push('writeBridgePlugin');
      return '/fake/.opencode/plugins/archie-bridge.ts';
    });
    createOpencode.mockImplementation(async () => {
      callOrder.push('createOpencode');
      return { client, server: {} };
    });
    const { getOpencodeClient } = await import('../server.js');
    const result = await getOpencodeClient();
    expect(result).toBe(client);
    expect(callOrder).toEqual(['startBridgeServer', 'writeBridgePlugin', 'createOpencode']);
  });

  it('exports a shared SessionRegistry usable by the runtime', async () => {
    createOpencode.mockResolvedValue({ client: {}, server: {} });
    const { sharedRegistry } = await import('../server.js');
    expect(sharedRegistry.get('nope')).toBeUndefined();
    const session = { task: {} as any, agent: {} as any, readOnly: false };
    sharedRegistry.set('sess-1', session);
    expect(sharedRegistry.get('sess-1')).toBe(session);
    sharedRegistry.delete('sess-1');
    expect(sharedRegistry.get('sess-1')).toBeUndefined();
  });

  it('closeOpencodeBridge is a no-op before the server has started', async () => {
    const { closeOpencodeBridge } = await import('../server.js');
    await expect(closeOpencodeBridge()).resolves.toBeUndefined();
    expect(startBridgeServer).not.toHaveBeenCalled();
  });

  it('closeOpencodeBridge closes the started bridge exactly once', async () => {
    const close = vi.fn(async () => {});
    startBridgeServer.mockResolvedValue(makeBridgeHandle({ close }));
    createOpencode.mockResolvedValue({ client: {}, server: {} });
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');
    await getOpencodeClient();

    await closeOpencodeBridge();
    await closeOpencodeBridge();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closeOpencodeBridge closes the embedded serve child exactly once (no orphaned process)', async () => {
    const serverClose = vi.fn();
    createOpencode.mockResolvedValue({ client: {}, server: { close: serverClose } });
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');
    await getOpencodeClient();

    await closeOpencodeBridge();
    await closeOpencodeBridge();

    expect(serverClose).toHaveBeenCalledTimes(1);
  });

  it('closes the just-spawned serve child if shutdown runs during the first boot (no orphan)', async () => {
    // Boot blocks in createOpencode; closeOpencodeBridge runs mid-flight.
    const serverClose = vi.fn();
    let resolveBoot: (v: { client: unknown; server: { close: () => void } }) => void = () => {};
    createOpencode.mockReturnValue(new Promise((res) => { resolveBoot = res; }));
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');

    const bootPromise = getOpencodeClient().catch((e) => e);
    // Let the bridge start + createOpencode be awaited, then tear down.
    await new Promise((r) => setImmediate(r));
    await closeOpencodeBridge();
    // Now the in-flight boot resolves — it must close the child, not keep it.
    resolveBoot({ client: {}, server: { close: serverClose } });
    const result = await bootPromise;

    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(Error);
  });

  it('closeOpencodeBridge clears the cached client so a later call re-boots the server', async () => {
    createOpencode.mockResolvedValue({ client: { session: {} }, server: { close: vi.fn() } });
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');
    await getOpencodeClient();
    await closeOpencodeBridge();
    await getOpencodeClient();

    expect(createOpencode).toHaveBeenCalledTimes(2);
  });

  it('closes the bridge and clears the client promise when createOpencode fails, allowing a clean retry', async () => {
    const close = vi.fn(async () => {});
    startBridgeServer.mockResolvedValueOnce(makeBridgeHandle({ close }));
    createOpencode.mockRejectedValueOnce(new Error('spawn opencode ENOENT'));
    const { getOpencodeClient } = await import('../server.js');

    await expect(getOpencodeClient()).rejects.toThrow('spawn opencode ENOENT');
    expect(close).toHaveBeenCalledTimes(1);

    // Retry: a fresh bridge is started and the server boots successfully.
    const client = { session: {} };
    startBridgeServer.mockResolvedValueOnce(makeBridgeHandle());
    createOpencode.mockResolvedValueOnce({ client, server: {} });
    await expect(getOpencodeClient()).resolves.toBe(client);
    expect(startBridgeServer).toHaveBeenCalledTimes(2);
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
