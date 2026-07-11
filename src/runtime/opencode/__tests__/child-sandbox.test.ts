import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { buildSandboxArgv, profileFingerprint, wrapServeCommand, SANDBOX_SYSTEM_ROBINDS, type ChildSandboxProfile } from '../child-sandbox.js';

vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: vi.fn(() => true) }));
// wrapServeCommand's bwrap-availability probe shells out to the real `bwrap`
// binary, which is Linux-only (absent here and on the bare CI runner) — mock
// it to always succeed so the linux-wrap test is deterministic, not
// environment-dependent.
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: vi.fn((_file: string, _args: unknown, cb: (err: Error | null) => void) => cb(null)),
}));

const profile = (over: Partial<ChildSandboxProfile> = {}): ChildSandboxProfile => ({
  cwd: '/clone', homeDir: '/root/home',
  roBinds: ['/ro/a'], rwBinds: ['/clone', '/tmp'], denyWriteRoBinds: ['/clone/.git/HEAD'],
  proxy: { url: 'http://u:p@127.0.0.1:9', noProxy: '127.0.0.1,localhost' },
  allowlist: ['openrouter.ai'], env: {}, cred: { username: 'u', password: 'p' },
  ...over,
});

describe('buildSandboxArgv', () => {
  it('ro-binds system paths, rw-binds cwd/home/tmp, and re-ro-binds denyWrite AFTER the rw binds', () => {
    const argv = buildSandboxArgv(profile());
    // system ro-binds present
    for (const p of SANDBOX_SYSTEM_ROBINDS) {
      const i = argv.indexOf(p);
      expect(argv[i - 1]).toBe('--ro-bind');
    }
    // rw bind for the clone
    const rwI = argv.indexOf('/clone');
    expect(argv[rwI - 1]).toBe('--bind');
    // deny re-bound as ro, and AFTER the rw bind of its parent (ordering = downgrade).
    // indexOf, not lastIndexOf: a real bwrap bind is `--ro-bind SRC DEST`, and for
    // an identity mount SRC === DEST === p, so p appears twice adjacently — the
    // flag precedes the FIRST (SRC) occurrence, not the last (DEST) one.
    const denyFlag = argv.indexOf('/clone/.git/HEAD');
    expect(argv[denyFlag - 1]).toBe('--ro-bind');
    expect(denyFlag).toBeGreaterThan(rwI);
    // hardening flags, and NO network namespace
    expect(argv).toEqual(expect.arrayContaining(['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev']));
    expect(argv).not.toContain('--unshare-net');
  });

  it('skips nonexistent bind paths (clone paths vary per task) but always binds cwd + home', () => {
    (existsSync as any).mockImplementation((p: string) => p === '/clone' || p === '/root/home' || SANDBOX_SYSTEM_ROBINDS.includes(p));
    const argv = buildSandboxArgv(profile({ roBinds: ['/does/not/exist'] }));
    expect(argv).not.toContain('/does/not/exist');
    expect(argv).toContain('/clone');
    expect(argv).toContain('/root/home');
  });
});

describe('profileFingerprint', () => {
  it('is stable across key/order noise and changes on a mount, allowlist, cwd, or home change', () => {
    const base = profileFingerprint(profile());
    expect(profileFingerprint(profile())).toBe(base);
    expect(profileFingerprint(profile({ rwBinds: ['/clone', '/tmp', '/extra'] }))).not.toBe(base); // RO→RW mount flip
    expect(profileFingerprint(profile({ allowlist: ['openrouter.ai', 'evil.com'] }))).not.toBe(base);
    expect(profileFingerprint(profile({ cwd: '/other' }))).not.toBe(base);
    expect(profileFingerprint(profile({ homeDir: '/other/home' }))).not.toBe(base);
  });
  it('ignores proxy CREDENTIALS in the url (they rotate per boot but the boundary is unchanged)', () => {
    expect(profileFingerprint(profile({ proxy: { url: 'http://u2:p2@127.0.0.1:9', noProxy: '127.0.0.1,localhost' } })))
      .toBe(profileFingerprint(profile()));
  });
});

describe('wrapServeCommand', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('on linux wraps with bwrap and appends opencode serve', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const { command, args } = await wrapServeCommand(profile());
    expect(command).toBe('bwrap');
    expect(args.slice(-3)).toEqual(['serve', '--hostname=127.0.0.1', '--port=0']);
    expect(args).toContain('opencode');
  });
  it('on darwin passes through unwrapped (warn path)', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const { command, args } = await wrapServeCommand(profile());
    expect(command).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname=127.0.0.1', '--port=0']);
  });
});
