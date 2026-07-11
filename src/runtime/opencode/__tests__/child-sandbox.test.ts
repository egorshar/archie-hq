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
  // Default shape = an EDIT-MODE repo agent: clone rw, clone/.opencode rw, home
  // rw, and .git/HEAD re-ro-bound (downgraded) inside the rw clone.
  cwd: '/clone', homeDir: '/root/home',
  roBinds: ['/ro/a'], rwBinds: ['/clone', '/clone/.opencode', '/root/home'], denyWriteRoBinds: ['/clone/.git/HEAD'],
  proxy: { url: 'http://u:p@127.0.0.1:9', noProxy: '127.0.0.1,localhost' },
  allowlist: ['openrouter.ai'], env: {}, cred: { username: 'u', password: 'p' },
  ...over,
});

/** First occurrence index of an exact identity-bind SRC path `p`, and the flag
 * that precedes it. A bwrap identity bind is `--flag SRC DEST` with SRC===DEST===p,
 * so p appears twice adjacently; the flag precedes the FIRST (SRC) occurrence. */
const bindOf = (argv: string[], p: string) => {
  const i = argv.indexOf(p);
  return { index: i, flag: i > 0 ? argv[i - 1] : undefined };
};

describe('buildSandboxArgv', () => {
  it('common shape: ro-binds system paths, tmpfs /tmp, hardening flags, and NO network namespace', () => {
    const argv = buildSandboxArgv(profile());
    for (const p of SANDBOX_SYSTEM_ROBINDS) {
      const i = argv.indexOf(p);
      expect(argv[i - 1]).toBe('--ro-bind');
    }
    expect(argv).toEqual(expect.arrayContaining(['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev']));
    expect(argv).not.toContain('--unshare-net');
  });

  it('RO repo agent: clone stays ro, clone/.opencode rw carve is NOT shadowed by a clone-root deny re-bind', () => {
    // RO agent: clone in roBinds (NOT rwBinds), cwd NOT in rwBinds, and the
    // clone ROOT in denyWriteRoBinds. The clone-root deny must be SKIPPED (it is
    // not inside any rw bind) — else its trailing --ro-bind /clone over-mounts
    // and hides the /clone/.opencode rw sub-bind (the C1 bug).
    const argv = buildSandboxArgv(profile({
      cwd: '/clone', roBinds: ['/clone'], rwBinds: ['/clone/.opencode', '/root/home'], denyWriteRoBinds: ['/clone'],
    }));
    const clone = bindOf(argv, '/clone');
    expect(clone.flag).toBe('--ro-bind');           // clone bound read-only
    const opencode = bindOf(argv, '/clone/.opencode');
    expect(opencode.flag).toBe('--bind');            // rw carve-out present
    expect(opencode.index).toBeGreaterThan(clone.index); // carve AFTER the ro clone
    // The killer assertion: no re-bind of the clone ROOT AFTER the rw carve —
    // the deny is skipped, so the carve survives (the exact '/clone' string,
    // not the '/clone/.opencode' rw path, must not reappear).
    expect(argv.slice(opencode.index + 1)).not.toContain('/clone');
    // And the clone root is never made writable at all (no --bind /clone pair).
    const cloneBindPair = argv.some((a, i) => a === '--bind' && argv[i + 1] === '/clone');
    expect(cloneBindPair).toBe(false);
  });

  it('edit-mode repo agent: clone rw, and clone/.git/HEAD re-ro-bound (downgraded) AFTER the rw clone', () => {
    const argv = buildSandboxArgv(profile()); // default = edit-mode shape
    const clone = bindOf(argv, '/clone');
    expect(clone.flag).toBe('--bind');               // clone writable
    const deny = bindOf(argv, '/clone/.git/HEAD');
    expect(deny.flag).toBe('--ro-bind');             // downgraded
    expect(deny.index).toBeGreaterThan(clone.index); // ordering = downgrade
  });

  it('synthetic-root agent (PM/plugin): the synthetic cwd is bound rw', () => {
    const argv = buildSandboxArgv(profile({
      cwd: '/synthetic', roBinds: [], rwBinds: ['/synthetic', '/synthetic/.opencode', '/root/home'], denyWriteRoBinds: [],
    }));
    const root = bindOf(argv, '/synthetic');
    expect(root.flag).toBe('--bind');
  });

  it('skips nonexistent bind paths (clone paths vary per task); cwd + home bind only when present in the lists', () => {
    (existsSync as any).mockImplementation((p: string) => p === '/clone' || p === '/clone/.opencode' || p === '/root/home' || SANDBOX_SYSTEM_ROBINDS.includes(p));
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

// Isolated module registry: wrapServeCommand caches its bwrap-availability
// probe (module-level `bwrapChecked`), so the fail-closed path needs a fresh
// import with an execFile mock that REJECTS — the file's top-level mock makes
// it succeed. resetModules + doMock give this test its own copy.
describe('wrapServeCommand fail-closed (Linux, bwrap unavailable)', () => {
  afterEach(() => { vi.doUnmock('node:child_process'); vi.doUnmock('node:fs'); vi.unstubAllGlobals(); vi.resetModules(); });
  it('rejects rather than running an opencode child unsandboxed on a non-darwin platform', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async (orig) => ({
      ...(await orig<typeof import('node:child_process')>()),
      execFile: vi.fn((_file: string, _args: unknown, cb: (err: Error | null) => void) => cb(new Error('bwrap: command not found'))),
    }));
    vi.doMock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: vi.fn(() => true) }));
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const mod = await import('../child-sandbox.js');
    const p: ChildSandboxProfile = {
      cwd: '/clone', homeDir: '/root/home', roBinds: [], rwBinds: ['/clone', '/root/home'], denyWriteRoBinds: [],
      proxy: { url: 'http://127.0.0.1:9', noProxy: '127.0.0.1,localhost' },
      allowlist: ['openrouter.ai'], env: {}, cred: { username: 'u', password: 'p' },
    };
    await expect(mod.wrapServeCommand(p)).rejects.toThrow(/bwrap not available/);
  });
});
