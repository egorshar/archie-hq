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
  const revokeCredential = vi.fn();
  return {
    WORKDIR_STUB: pathJoin(osTmpdir(), `oc-pool-${process.pid}`),
    startEmbeddedServer: vi.fn(),
    prepareServeRoot: vi.fn(async () => {}),
    getBridge: vi.fn(),
    stageAgentSkills: vi.fn(async () => 1),
    excludeOpencodeFromGit: vi.fn(async () => {}),
    vendorBridgeDeps: vi.fn(async () => {}),
    writeBridgePlugin: vi.fn(async () => '/plugin/path'),
    buildOpencodeMcpConfig: vi.fn(async () => ({})),
    startEventConsumer: vi.fn(),
    loggerWarn: vi.fn(),
    buildChildSandboxProfile: vi.fn(() => ({
      cwd: '/clone', homeDir: '/h', roBinds: [], rwBinds: ['/clone', '/h'], denyWriteRoBinds: [],
      proxy: { url: 'http://127.0.0.1:9', noProxy: '127.0.0.1' }, allowlist: ['openrouter.ai'],
      env: { HOME: '/h' }, cred: { username: 'u', password: 'p' },
    })),
    wrapServeCommand: vi.fn(async () => ({ command: 'bwrap', args: ['opencode', 'serve'] })),
    agentProfileFingerprint: vi.fn((_agent: unknown, _task: unknown, _cwd: string, _editAllowed: boolean) => 'fp-base'),
    agentHomeDir: vi.fn((_taskId: string, _agentId: string) => pathJoin(osTmpdir(), `oc-pool-${process.pid}`, 'child-home')),
    revokeCredential,
    fsMkdir: vi.fn(async () => undefined),
    getEgressProxy: vi.fn(async () => ({
      url: 'http://127.0.0.1:9',
      mintCredential: vi.fn(() => ({ username: 'u', password: 'p' })),
      revokeCredential,
      close: vi.fn(),
    })),
  };
  // (declared above the returned object literal so getEgressProxy's factory
  // and the outer test file can share the SAME spy instance — `mocks` is only
  // bound once vi.hoisted() returns, so it can't be referenced from inside
  // this callback.)
});
vi.mock('../embedded-server.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, startEmbeddedServer: mocks.startEmbeddedServer, prepareServeRoot: mocks.prepareServeRoot };
});
vi.mock('../server.js', () => ({ getBridge: mocks.getBridge, sharedRegistry: { set: vi.fn(), get: vi.fn(), delete: vi.fn() } }));
vi.mock('../skills.js', () => ({ stageAgentSkills: mocks.stageAgentSkills, excludeOpencodeFromGit: mocks.excludeOpencodeFromGit, vendorBridgeDeps: mocks.vendorBridgeDeps }));
vi.mock('../bridge/plugin-source.js', () => ({ writeBridgePlugin: mocks.writeBridgePlugin }));
vi.mock('../mcp-config.js', () => ({ buildOpencodeMcpConfig: mocks.buildOpencodeMcpConfig }));
vi.mock('../events.js', () => ({ startEventConsumer: mocks.startEventConsumer }));
vi.mock('../child-sandbox.js', () => ({
  buildChildSandboxProfile: mocks.buildChildSandboxProfile,
  wrapServeCommand: mocks.wrapServeCommand,
  agentProfileFingerprint: mocks.agentProfileFingerprint,
  agentHomeDir: mocks.agentHomeDir,
}));
vi.mock('../egress-proxy.js', () => ({ getEgressProxy: mocks.getEgressProxy }));
// serve-pool.ts's own `mkdir(agentHomeDir(...))` call (the homeDir-exists
// invariant) is real disk I/O — genuinely slower than the purely-mocked,
// microtask-resolved preamble steps around it. Left real, it races the
// closeServePool()-mid-boot tests below (their `await closeServePool()`
// resolves on microtasks alone and can return before this I/O completes,
// leaving e.g. `resolveBoot` never captured). Stub it to a fast microtask
// resolve — serve-pool.ts imports mkdir from 'node:fs/promises' (prefixed);
// the test's OWN setup/teardown import the bare 'fs/promises' specifier, a
// distinct module id, so their real mkdir/rm/access are unaffected.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: mocks.fsMkdir };
});
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
    // vi.clearAllMocks() clears call history but NOT a custom mockImplementation
    // set by a previous test — restore the default constant fingerprint here so
    // a test that drives it by cwd (below) can't leak into a later test.
    mocks.agentProfileFingerprint.mockImplementation(() => 'fp-base');
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
    // Clear the child-tuning knobs a test may have set (the census test sets
    // SOFT_CAP='1') so they don't leak into later test files in the same worker.
    delete process.env.OPENCODE_CHILD_IDLE_TTL;
    delete process.env.OPENCODE_CHILD_SOFT_CAP;
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

  it('P3b: vendors the bridge plugin dep into the child .opencode/node_modules before spawn', async () => {
    const h = await getAgentServe(agentOf('pm-agent'), taskOf('t1'));
    expect(mocks.vendorBridgeDeps).toHaveBeenCalledWith(join(h.cwd, '.opencode', 'node_modules'));
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
    // The pool no longer compares cwd directly (P3b) — it recycles on a
    // fingerprint mismatch, and cwd is one of the fingerprint's inputs. Drive
    // the (mocked) fingerprint by the cwd argument to exercise that path.
    mocks.agentProfileFingerprint.mockImplementation((_agent: unknown, _task: unknown, cwd: string) => `fp:${cwd}`);
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

  it('boot failure rejects, revokes the minted token AND the minted proxy credential, and leaves the pool retryable', async () => {
    mocks.startEmbeddedServer.mockRejectedValueOnce(new Error('spawn opencode ENOENT'));
    await expect(getAgentServe(agentOf('backend'), taskOf('t1'))).rejects.toThrow('ENOENT');
    expect(bridge.revokeChildToken).toHaveBeenCalledWith('child-token-1');
    expect(mocks.revokeCredential).toHaveBeenCalledWith({ username: 'u', password: 'p' });
    await expect(getAgentServe(agentOf('backend'), taskOf('t1'))).resolves.toBeTruthy();
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(2);
  });

  it('spawns the child through wrapServeCommand with the profile env and records the fingerprint', async () => {
    const h = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    const call = mocks.startEmbeddedServer.mock.calls[0][0];
    expect(call.spawnOverride).toEqual({ command: 'bwrap', args: ['opencode', 'serve'] });
    expect(call.env).toEqual(expect.objectContaining({ HOME: '/h' }));
    expect(h.fingerprint).toBe('fp-base');
  });

  it('creates the per-agent homeDir on disk BEFORE spawning (buildSandboxArgv silently skips a nonexistent bind source)', async () => {
    await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    expect(mocks.fsMkdir).toHaveBeenCalledWith(mocks.agentHomeDir('t1', 'backend'), { recursive: true });
    // Ordering: the mkdir call must land before the spawn, not just "also happen".
    const mkdirCallOrder = mocks.fsMkdir.mock.invocationCallOrder[0];
    const spawnCallOrder = mocks.startEmbeddedServer.mock.invocationCallOrder[0];
    expect(mkdirCallOrder).toBeLessThan(spawnCallOrder);
  });

  it('recycles a warm child when the profile fingerprint changes (RO→RW mount flip on the SAME cwd)', async () => {
    mocks.agentProfileFingerprint.mockReturnValueOnce('fp-ro'); // boot: stored on the handle
    const h1 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    mocks.agentProfileFingerprint.mockReturnValue('fp-rw'); // next acquire: desired differs → recycle
    const h2 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    expect(h2).not.toBe(h1);
    expect(h1.isClosed()).toBe(true);
  });

  it('does NOT recycle when the fingerprint is unchanged (warm reuse, no mint on the warm path)', async () => {
    const h1 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    const h2 = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    expect(h2).toBe(h1);
    expect(mocks.startEmbeddedServer).toHaveBeenCalledTimes(1);
  });

  it('revokes the proxy credential on close', async () => {
    const h = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: '/clone' });
    await h.close();
    expect(mocks.revokeCredential).toHaveBeenCalled();
  });

  it('closeServePool closes every child and a boot resolving after shutdown is closed too', async () => {
    const h = await getAgentServe(agentOf('backend'), taskOf('t1'));
    let resolveBoot: ((v: any) => void) | undefined;
    mocks.startEmbeddedServer.mockImplementationOnce(() => new Promise((r) => { resolveBoot = r; }));
    const inFlight = getAgentServe(agentOf('mobile'), taskOf('t1'));
    await closeServePool();
    expect(h.isClosed()).toBe(true);
    // The P3b preamble (egress-proxy fetch + wrapServeCommand, on top of the
    // existing bridge/skills/mcp wave) adds microtask ticks before mobile's
    // boot reaches startEmbeddedServer — more than closeServePool's own
    // (near-instant, nothing real to await) resolution takes. Poll for the
    // in-flight boot to actually reach the spawn call instead of assuming a
    // fixed tick count.
    await vi.waitFor(() => { if (!resolveBoot) throw new Error('boot has not reached startEmbeddedServer yet'); });
    const late = fakeEmbedded();
    resolveBoot!(late.server);
    await inFlight.catch(() => {}); // boot-after-teardown rejects or resolves-closed; either way the child is killed
    expect(late.closed).toHaveBeenCalled();
  });

  it('generation guard: a boot still in flight during closeServePool is closed even after a later boot restarts the pool', async () => {
    // Boot A parks on a deferred startEmbeddedServer.
    let resolveA!: (v: any) => void;
    const lateA = fakeEmbedded('http://127.0.0.1:7001');
    mocks.startEmbeddedServer.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    const bootA = getAgentServe(agentOf('backend'), taskOf('t1'));

    // Shutdown while A is still booting (does NOT await A → bumps the generation).
    await closeServePool();

    // A fresh boot B resolves normally AFTER shutdown. Under the old boolean
    // guard this reset shuttingDown=false and A's post-spawn guard then kept
    // A's child alive with no pool entry to ever close it (orphan). The
    // generation token keeps A doomed while letting B live.
    const liveB = fakeEmbedded('http://127.0.0.1:7002');
    mocks.startEmbeddedServer.mockImplementationOnce(async () => liveB.server);
    const hB = await getAgentServe(agentOf('mobile'), taskOf('t1'));
    expect(hB.isClosed()).toBe(false);

    // A's deferred server resolves last: its generation is stale → child closed, acquire rejects.
    resolveA(lateA.server);
    await expect(bootA).rejects.toThrow(/aborted during shutdown/);
    expect(lateA.closed).toHaveBeenCalled();

    // B is untouched.
    expect(hB.isClosed()).toBe(false);
    expect(liveChildCount()).toBe(1);
  });

  it('shared clone (P3a): a second same-task agent falls back to its synthetic root; both live; no recycle thrash', async () => {
    const clone = join(WORKDIR_STUB, 'clones', 'shared');
    const hA = await getAgentServe(agentOf('backend'), taskOf('t1'), { clonePath: clone });
    const hB = await getAgentServe(agentOf('mobile'), taskOf('t1'), { clonePath: clone });

    expect(hA.cwd).toBe(clone); // first agent keeps the clone
    expect(hB.cwd).toBe(join(WORKDIR_STUB, 'opencode-server', 't1', 'mobile')); // second falls back
    expect(mocks.loggerWarn).toHaveBeenCalledWith('opencode', expect.stringContaining(clone));
    expect(hA.isClosed()).toBe(false);
    expect(hB.isClosed()).toBe(false);
    expect(liveChildCount()).toBe(2);

    // Re-acquire B while A is live → still synthetic (handle.cwd matches the
    // effective desired cwd), so the warm handle is reused, not recycled.
    const calls = mocks.startEmbeddedServer.mock.calls.length;
    const hB2 = await getAgentServe(agentOf('mobile'), taskOf('t1'), { clonePath: clone });
    expect(hB2).toBe(hB);
    expect(mocks.startEmbeddedServer.mock.calls.length).toBe(calls);
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
