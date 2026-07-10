import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// The embedded server is now started via a manual `opencode serve` spawn in a
// clean, git-bounded serve root (embedded-server.ts) — not the SDK's
// createOpencode. Mock that boundary + the skill staging + the workdir root.
const startEmbeddedServer = vi.fn();
const prepareServeRoot = vi.fn(async () => {});
vi.mock('../embedded-server.js', () => ({ startEmbeddedServer, prepareServeRoot }));

const stageOpencodeSkills = vi.fn(async () => 0);
vi.mock('../skills.js', () => ({ stageOpencodeSkills }));

vi.mock('../../../system/workdir.js', () => ({ WORKDIR: '/fake-workdir' }));

const writeBridgePlugin = vi.fn();
vi.mock('../bridge/plugin-source.js', () => ({ writeBridgePlugin }));

const startBridgeServer = vi.fn();
vi.mock('../bridge/server.js', () => ({ startBridgeServer }));

const resolveOpencodeModel = vi.fn();
vi.mock('../model.js', () => ({ resolveOpencodeModel }));

// Mock the MCP-config builder so the startEmbeddedServer call-args assertion is
// hermetic: it reflects this mock, NOT ambient disk/vault state.
vi.mock('../mcp-config.js', () => ({ buildOpencodeMcpConfig: vi.fn(async () => ({})) }));

const SERVE_ROOT = join('/fake-workdir', 'opencode-server');

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
    startEmbeddedServer.mockReset();
    prepareServeRoot.mockReset();
    prepareServeRoot.mockResolvedValue(undefined);
    stageOpencodeSkills.mockReset();
    stageOpencodeSkills.mockResolvedValue(0);
    writeBridgePlugin.mockReset();
    startBridgeServer.mockReset();
    resolveOpencodeModel.mockReset();

    writeBridgePlugin.mockResolvedValue('/fake/.opencode/plugins/archie-bridge.ts');
    startBridgeServer.mockResolvedValue(makeBridgeHandle());
    resolveOpencodeModel.mockReturnValue({ providerID: 'anthropic', modelID: 'opus' });
  });

  it('starts the embedded server once and reuses the client', async () => {
    const client = { session: {} };
    startEmbeddedServer.mockResolvedValue({ client, close: vi.fn() });
    const { getOpencodeClient } = await import('../server.js');
    const a = await getOpencodeClient();
    const b = await getOpencodeClient();
    expect(a).toBe(client);
    expect(b).toBe(client);
    expect(startEmbeddedServer).toHaveBeenCalledTimes(1);
    expect(startBridgeServer).toHaveBeenCalledTimes(1);
  });

  it('ALWAYS wires bridge + skills + config.model + config.permission in a clean serve root', async () => {
    const client = { session: {} };
    startEmbeddedServer.mockResolvedValue({ client, close: vi.fn() });
    const { getOpencodeClient, sharedRegistry } = await import('../server.js');

    const result = await getOpencodeClient();

    expect(result).toBe(client);
    expect(startBridgeServer).toHaveBeenCalledWith(sharedRegistry);
    // Serve root is prepared (git-bounded) and skills staged there — under the
    // workdir, NOT the process cwd (which carries the repo's own .claude/skills).
    expect(prepareServeRoot).toHaveBeenCalledWith(SERVE_ROOT);
    expect(stageOpencodeSkills).toHaveBeenCalledWith(join(SERVE_ROOT, '.opencode', 'skills'));
    expect(writeBridgePlugin).toHaveBeenCalledWith(
      join(SERVE_ROOT, '.opencode', 'plugins'),
      'http://127.0.0.1:9999',
      'tok-xyz',
    );
    expect(resolveOpencodeModel).toHaveBeenCalledWith('default');
    expect(startEmbeddedServer).toHaveBeenCalledWith({
      cwd: SERVE_ROOT,
      config: {
        model: 'anthropic/opus',
        permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
        mcp: {},
      },
    });
  });

  it('starts the bridge and writes the plugin before booting the embedded server', async () => {
    const client = { session: {} };
    const callOrder: string[] = [];
    startBridgeServer.mockImplementation(async () => {
      callOrder.push('startBridgeServer');
      return makeBridgeHandle();
    });
    writeBridgePlugin.mockImplementation(async () => {
      callOrder.push('writeBridgePlugin');
      return '/fake/.opencode/plugins/archie-bridge.ts';
    });
    startEmbeddedServer.mockImplementation(async () => {
      callOrder.push('startEmbeddedServer');
      return { client, close: vi.fn() };
    });
    const { getOpencodeClient } = await import('../server.js');
    const result = await getOpencodeClient();
    expect(result).toBe(client);
    expect(callOrder).toEqual(['startBridgeServer', 'writeBridgePlugin', 'startEmbeddedServer']);
  });

  it('exports a shared SessionRegistry usable by the runtime', async () => {
    startEmbeddedServer.mockResolvedValue({ client: {}, close: vi.fn() });
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
    startEmbeddedServer.mockResolvedValue({ client: {}, close: vi.fn() });
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');
    await getOpencodeClient();

    await closeOpencodeBridge();
    await closeOpencodeBridge();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closeOpencodeBridge closes the embedded serve child exactly once (no orphaned process)', async () => {
    const serverClose = vi.fn();
    startEmbeddedServer.mockResolvedValue({ client: {}, close: serverClose });
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');
    await getOpencodeClient();

    await closeOpencodeBridge();
    await closeOpencodeBridge();

    expect(serverClose).toHaveBeenCalledTimes(1);
  });

  it('closes the just-spawned serve child if shutdown runs during the first boot (no orphan)', async () => {
    // Boot blocks in startEmbeddedServer; closeOpencodeBridge runs mid-flight.
    const serverClose = vi.fn();
    let resolveBoot: (v: { client: unknown; close: () => void }) => void = () => {};
    startEmbeddedServer.mockReturnValue(new Promise((res) => { resolveBoot = res; }));
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');

    const bootPromise = getOpencodeClient().catch((e) => e);
    await new Promise((r) => setImmediate(r));
    await closeOpencodeBridge();
    // Now the in-flight boot resolves — it must close the child, not keep it.
    resolveBoot({ client: {}, close: serverClose });
    const result = await bootPromise;

    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(Error);
  });

  it('closeOpencodeBridge clears the cached client so a later call re-boots the server', async () => {
    startEmbeddedServer.mockResolvedValue({ client: { session: {} }, close: vi.fn() });
    const { getOpencodeClient, closeOpencodeBridge } = await import('../server.js');
    await getOpencodeClient();
    await closeOpencodeBridge();
    await getOpencodeClient();

    expect(startEmbeddedServer).toHaveBeenCalledTimes(2);
  });

  it('closes the bridge and clears the client promise when the boot fails, allowing a clean retry', async () => {
    const close = vi.fn(async () => {});
    startBridgeServer.mockResolvedValueOnce(makeBridgeHandle({ close }));
    startEmbeddedServer.mockRejectedValueOnce(new Error('opencode serve did not start'));
    const { getOpencodeClient } = await import('../server.js');

    await expect(getOpencodeClient()).rejects.toThrow('opencode serve did not start');
    expect(close).toHaveBeenCalledTimes(1);

    // Retry: a fresh bridge is started and the server boots successfully.
    const client = { session: {} };
    startBridgeServer.mockResolvedValueOnce(makeBridgeHandle());
    startEmbeddedServer.mockResolvedValueOnce({ client, close: vi.fn() });
    await expect(getOpencodeClient()).resolves.toBe(client);
    expect(startBridgeServer).toHaveBeenCalledTimes(2);
  });

  it('restageOpencodeSkills is a NO-OP (and does not boot the server) when the singleton is not started', async () => {
    const { restageOpencodeSkills } = await import('../server.js');
    await expect(restageOpencodeSkills()).resolves.toBeUndefined();
    // Server never touched: no boot side effects, no staging.
    expect(startBridgeServer).not.toHaveBeenCalled();
    expect(startEmbeddedServer).not.toHaveBeenCalled();
    expect(stageOpencodeSkills).not.toHaveBeenCalled();
  });

  it('restageOpencodeSkills re-stages the serve root with trigger=plugins-refresh once the server is started', async () => {
    startEmbeddedServer.mockResolvedValue({ client: { session: {} }, close: vi.fn() });
    // resetModules() (beforeEach) gives server.js a fresh logger singleton — spy
    // on THAT instance, imported from the same reset module graph.
    const { logger } = await import('../../../system/logger.js');
    const sys = vi.spyOn(logger, 'system').mockImplementation(() => {});
    const { getOpencodeClient, restageOpencodeSkills } = await import('../server.js');
    await getOpencodeClient(); // boot → one staging call (trigger=boot)
    stageOpencodeSkills.mockClear();
    sys.mockClear();

    await restageOpencodeSkills();

    expect(stageOpencodeSkills).toHaveBeenCalledTimes(1);
    expect(stageOpencodeSkills).toHaveBeenCalledWith(join(SERVE_ROOT, '.opencode', 'skills'));
    expect(sys).toHaveBeenCalledWith(expect.stringContaining('trigger=plugins-refresh'));
    sys.mockRestore();
  });

  it('restageOpencodeSkills is best-effort: a staging failure is logged and swallowed (previous staging stays in effect)', async () => {
    startEmbeddedServer.mockResolvedValue({ client: { session: {} }, close: vi.fn() });
    const { logger } = await import('../../../system/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { getOpencodeClient, restageOpencodeSkills } = await import('../server.js');
    await getOpencodeClient();
    stageOpencodeSkills.mockRejectedValueOnce(new Error('disk full'));

    // Must NOT throw — a failed re-stage can't break the plugins refresh.
    await expect(restageOpencodeSkills()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'opencode',
      expect.stringContaining('previous staging remains in effect'),
    );
    warn.mockRestore();
  });

  it('coalesces a concurrent double-trigger into one in-flight + exactly one trailing run', async () => {
    startEmbeddedServer.mockResolvedValue({ client: { session: {} }, close: vi.fn() });
    const { getOpencodeClient, restageOpencodeSkills } = await import('../server.js');
    await getOpencodeClient();
    stageOpencodeSkills.mockClear();

    // Make each staging run block until we release it, so we can fire concurrent
    // triggers while the first run is in flight.
    const resolvers: Array<(v: number) => void> = [];
    stageOpencodeSkills.mockImplementation(() => new Promise<number>((res) => resolvers.push(res)));

    const p1 = restageOpencodeSkills(); // starts run #1
    const p2 = restageOpencodeSkills(); // queued (in-flight)
    const p3 = restageOpencodeSkills(); // still queued — collapses onto the same trailing run
    await Promise.resolve();
    expect(stageOpencodeSkills).toHaveBeenCalledTimes(1); // only run #1 started so far

    resolvers[0](0); // finish run #1 → trailing run #2 starts
    await new Promise((r) => setTimeout(r, 0));
    expect(stageOpencodeSkills).toHaveBeenCalledTimes(2); // exactly one trailing run

    resolvers[1](0); // finish run #2 → no further runs (queue drained)
    await Promise.all([p1, p2, p3]);
    expect(stageOpencodeSkills).toHaveBeenCalledTimes(2);
  });

  it('concatPromptText joins text parts and returns null when empty', async () => {
    const { concatPromptText } = await import('../server.js');
    expect(concatPromptText({ data: { parts: [
      { type: 'text', text: 'he' }, { type: 'tool', text: 'x' }, { type: 'text', text: 'llo' },
    ] } })).toBe('hello');
    expect(concatPromptText({ data: { parts: [] } })).toBeNull();
    expect(concatPromptText({ data: { info: { error: { name: 'X' } } } })).toBeNull();
  });
});
