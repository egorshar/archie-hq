import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// vi.mock factories are hoisted above these imports; a plain top-level const
// referenced inside one throws "Cannot access before initialization" under
// this vitest version, so WORKDIR_STUB is created inside vi.hoisted (same
// pattern as runtime.test.ts / llm-one-shot.test.ts). The hoisted callback
// runs before the `join`/`tmpdir` ES imports below are initialized too, so it
// requires node:os/node:path directly rather than closing over those bindings.
const { WORKDIR_STUB, ...mocks } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: osTmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: pathJoin } = require('node:path');
  return {
    WORKDIR_STUB: pathJoin(osTmpdir(), `oc-pool-${process.pid}`),
    startEmbeddedServer: vi.fn(),
    prepareServeRoot: vi.fn(async () => {}),
    getBridge: vi.fn(),
    stageAgentSkills: vi.fn(async () => 1),
    excludeOpencodeFromGit: vi.fn(async () => {}),
    writeBridgePlugin: vi.fn(async () => '/plugin/path'),
    buildOpencodeMcpConfig: vi.fn(async () => ({})),
    startEventConsumer: vi.fn(),
    loggerWarn: vi.fn(),
  };
});
vi.mock('../embedded-server.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, startEmbeddedServer: mocks.startEmbeddedServer, prepareServeRoot: mocks.prepareServeRoot };
});
vi.mock('../server.js', () => ({ getBridge: mocks.getBridge, sharedRegistry: { set: vi.fn(), get: vi.fn(), delete: vi.fn() } }));
vi.mock('../skills.js', () => ({ stageAgentSkills: mocks.stageAgentSkills, excludeOpencodeFromGit: mocks.excludeOpencodeFromGit }));
vi.mock('../bridge/plugin-source.js', () => ({ writeBridgePlugin: mocks.writeBridgePlugin }));
vi.mock('../mcp-config.js', () => ({ buildOpencodeMcpConfig: mocks.buildOpencodeMcpConfig }));
vi.mock('../events.js', () => ({ startEventConsumer: mocks.startEventConsumer }));
vi.mock('../../../system/workdir.js', () => ({ WORKDIR: WORKDIR_STUB }));
vi.mock('../../../system/logger.js', () => ({
  logger: { system: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn(), agent: vi.fn() },
}));

import {
  getAgentServe, scheduleIdleReap, markAllServesStale, evictTask, closeServePool,
  liveChildCount, childIdleTtlMs, childSoftCap,
} from '../serve-pool.js';

const agentOf = (id: string, model = 'opus') => ({ def: { id, model } }) as any;
const taskOf = (taskId: string) => ({ taskId }) as any;

let exitCallbacks: Array<() => void>;
function fakeEmbedded(url = 'http://127.0.0.1:9999') {
  const closed = vi.fn();
  const server = {
    client: { session: {} },
    url,
    close: closed,
    onExit: (cb: () => void) => exitCallbacks.push(cb),
  };
  return { server, closed };
}

let mintCount: number;
function fakeBridge() {
  const revoked: string[] = [];
  return {
    url: 'http://127.0.0.1:8888',
    token: 'process-token',
    mintChildToken: vi.fn(() => `child-token-${++mintCount}`),
    revokeChildToken: vi.fn((t: string) => revoked.push(t)),
    close: vi.fn(async () => {}),
    __revoked: revoked,
  };
}

describe('serve pool (P3a §1/§5)', () => {
  let bridge: ReturnType<typeof fakeBridge>;

  beforeEach(async () => {
    vi.clearAllMocks();
    exitCallbacks = [];
    mintCount = 0;
    bridge = fakeBridge();
    mocks.getBridge.mockResolvedValue(bridge);
    mocks.startEmbeddedServer.mockImplementation(async () => fakeEmbedded().server);
    mocks.startEventConsumer.mockReturnValue({ stop: vi.fn() });
    process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openrouter/z-ai/glm-4.7';
    process.env.ARCHIE_OPENCODE_MODEL_OPUS = 'openrouter/z-ai/glm-5.2';
    delete process.env.OPENCODE_CHILD_IDLE_TTL;
    delete process.env.OPENCODE_CHILD_SOFT_CAP;
    await mkdir(WORKDIR_STUB, { recursive: true });
  });

  afterEach(async () => {
    await closeServePool();
    await rm(WORKDIR_STUB, { recursive: true, force: true });
    delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
    delete process.env.ARCHIE_OPENCODE_MODEL_OPUS;
    vi.useRealTimers();
  });

  it('boots once per {taskId, agentId} — concurrent callers share one boot', async () => {
    const [a, b] = await Promise.all([
      getAgentServe(agentOf('backend'), taskOf('t1')),
      getAgentServe(agentOf('backend'), taskOf('t1')),
    ]);
    expect(a).toBe(b);
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(1);
    await getAgentServe(agentOf('mobile'), taskOf('t1'));
    await getAgentServe(agentOf('backend'), taskOf('t2'));
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(3);
    expect(liveChildCount()).toBe(3);
  });

  it("boots with config.model = the AGENT's route and a per-child minted token in the plugin", async () => {
    const h = await getAgentServe(agentOf('backend', 'opus'), taskOf('t1'));
    const cfg = mocks.startEmbeddedServer.mock.calls[0][0].config;
    expect(cfg.model).toBe('openrouter/z-ai/glm-5.2');
    expect(cfg.permission).toBeTruthy();
    expect(bridge.mintChildToken).toHaveBeenCalledWith({ taskId: 't1', agentId: 'backend' });
    expect(h.token).toBe('child-token-1');
    expect(mocks.writeBridgePlugin).toHaveBeenCalledWith(expect.stringContaining('.opencode/plugins'), bridge.url, 'child-token-1');
  });

  it('synthetic root for clone-less agents: prepared + staged under <workdir>/opencode-server/<task>/<agent>', async () => {
    const h = await getAgentServe(agentOf('pm-agent'), taskOf('t1'));
    const expected = join(WORKDIR_STUB, 'opencode-server', 't1', 'pm-agent');
    expect(h.cwd).toBe(expected);
    expect(mocks.prepareServeRoot).toHaveBeenCalledWith(expected);
    expect(mocks.stageAgentSkills).toHaveBeenCalledWith(expect.objectContaining({ id: 'pm-agent' }), join(expected, '.opencode', 'skills'));
    expect(mocks.excludeOpencodeFromGit).not.toHaveBeenCalled();
  });

  it('clone cwd for repo agents: no synthetic prepare; .opencode excluded from git', async () => {
    const clone = join(WORKDIR_STUB, 'clones', 'backend');
    const h = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: clone });
    expect(h.cwd).toBe(clone);
    expect(mocks.prepareServeRoot).not.toHaveBeenCalled();
    expect(mocks.excludeOpencodeFromGit).toHaveBeenCalledWith(clone);
    expect(mocks.startEmbeddedServer).toHaveBeenCalledWith(expect.objectContaining({ cwd: clone }));
  });

  it('stale recycle: markStale → next acquire closes the old child and boots a fresh one', async () => {
    const h1 = await getAgentServe(agentOf('backend'), taskOf('t1'));
    h1.markStale('plugins');
    const h2 = await getAgentServe(agentOf('backend'), taskOf('t1'));
    expect(h2).not.toBe(h1);
    expect(h1.isClosed()).toBe(true);
    expect(bridge.revokeChildToken).toHaveBeenCalledWith(h1.token);
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(2);
  });

  it('cwd change under a constant key (RO→RW clone re-create) recycles as mode-transition', async () => {
    const h1 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clones/ro' });
    const h2 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clones/rw' });
    expect(h1.isClosed()).toBe(true);
    expect(h2.cwd).toBe('/clones/rw');
  });

  it('same cwd + not stale → warm handle is reused (no recycle)', async () => {
    const h1 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clones/x' });
    const h2 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clones/x' });
    expect(h2).toBe(h1);
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(1);
  });

  it('idle reap: parked past TTL closes the child (root kept) and disarm prevents it', async () => {
    vi.useFakeTimers();
    const agent = agentOf('backend');
    const task = taskOf('t1');
    const h = await getAgentServe(agent, task);

    // Armed and left to fire → reaped.
    scheduleIdleReap(agent, task);
    vi.advanceTimersByTime(childIdleTtlMs() + 1);
    expect(h.isClosed()).toBe(true);
    expect(liveChildCount()).toBe(0);

    // Re-acquire (next inbound message) boots a fresh child.
    const h2 = await getAgentServe(agent, task);
    expect(h2.isClosed()).toBe(false);

    // Armed then disarmed (message arrived / turn started) → NOT reaped.
    const disarm = scheduleIdleReap(agent, task);
    disarm();
    vi.advanceTimersByTime(childIdleTtlMs() * 2);
    expect(h2.isClosed()).toBe(false);
  });

  it('OPENCODE_CHILD_IDLE_TTL parses 15m / 30s / bare ms; garbage falls back to the default', () => {
    process.env.OPENCODE_CHILD_IDLE_TTL = '30s';
    expect(childIdleTtlMs()).toBe(30_000);
    process.env.OPENCODE_CHILD_IDLE_TTL = '2h';
    expect(childIdleTtlMs()).toBe(7_200_000);
    process.env.OPENCODE_CHILD_IDLE_TTL = '90000';
    expect(childIdleTtlMs()).toBe(90_000);
    process.env.OPENCODE_CHILD_IDLE_TTL = 'soon';
    expect(childIdleTtlMs()).toBe(15 * 60_000);
    delete process.env.OPENCODE_CHILD_IDLE_TTL;
    expect(childIdleTtlMs()).toBe(15 * 60_000);
  });

  it('markAllServesStale marks every live child (plugins push)', async () => {
    const h1 = await getAgentServe(agentOf('backend'), taskOf('t1'));
    const h2 = await getAgentServe(agentOf('mobile'), taskOf('t2'));
    markAllServesStale('plugins');
    expect(h1.isStale()).toBe(true);
    expect(h2.isStale()).toBe(true);
  });

  it('dead child (A5): process exit evicts eagerly; next acquire boots a new one', async () => {
    const h = await getAgentServe(agentOf('backend'), taskOf('t1'));
    exitCallbacks.forEach((cb) => cb()); // the child crashed
    expect(h.isClosed()).toBe(true);
    expect(liveChildCount()).toBe(0);
    await getAgentServe(agentOf('backend'), taskOf('t1'));
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(2);
  });

  it('evictTask closes only that task’s children and rm’s its serve-root dir (A5 leak guarantee)', async () => {
    const taskRoot = join(WORKDIR_STUB, 'opencode-server', 't1');
    await mkdir(join(taskRoot, 'pm-agent'), { recursive: true });
    const h1 = await getAgentServe(agentOf('pm-agent'), taskOf('t1'));
    const hOther = await getAgentServe(agentOf('pm-agent'), taskOf('t2'));
    await evictTask('t1');
    expect(h1.isClosed()).toBe(true);
    expect(hOther.isClosed()).toBe(false);
    await expect(access(taskRoot)).rejects.toThrow(); // dir removed
  });

  it('boot failure rejects, revokes the minted token, and leaves the pool retryable', async () => {
    mocks.startEmbeddedServer.mockRejectedValueOnce(new Error('spawn opencode ENOENT'));
    await expect(getAgentServe(agentOf('backend'), taskOf('t1'))).rejects.toThrow('ENOENT');
    expect(bridge.revokeChildToken).toHaveBeenCalledWith('child-token-1');
    await expect(getAgentServe(agentOf('backend'), taskOf('t1'))).resolves.toBeTruthy();
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(2);
  });

  it('closeServePool closes every child and a boot resolving after shutdown is closed too', async () => {
    const h = await getAgentServe(agentOf('backend'), taskOf('t1'));
    let resolveBoot!: (v: any) => void;
    mocks.startEmbeddedServer.mockImplementationOnce(() => new Promise((r) => { resolveBoot = r; }));
    const inFlight = getAgentServe(agentOf('mobile'), taskOf('t1'));
    await closeServePool();
    expect(h.isClosed()).toBe(true);
    const late = fakeEmbedded();
    resolveBoot(late.server);
    await inFlight.catch(() => {}); // boot-after-teardown rejects or resolves-closed; either way the child is killed
    expect(late.closed).toHaveBeenCalled();
  });

  it('census: exceeding OPENCODE_CHILD_SOFT_CAP warn-logs but never blocks', async () => {
    process.env.OPENCODE_CHILD_SOFT_CAP = '1';
    await getAgentServe(agentOf('backend'), taskOf('t1'));
    await getAgentServe(agentOf('mobile'), taskOf('t1'));
    expect(liveChildCount()).toBe(2); // not blocked
    expect(mocks.loggerWarn).toHaveBeenCalledWith('opencode', expect.stringContaining('OPENCODE_CHILD_SOFT_CAP'));
    expect(childSoftCap()).toBe(1);
  });
});
