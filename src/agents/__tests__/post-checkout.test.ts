import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Controllable exec mock: capture the call, and let each test decide whether
// the (promisified) exec resolves or rejects.
const { execMock, loggerWarn, loggerSystem } = vi.hoisted(() => ({
  execMock: vi.fn(),
  loggerWarn: vi.fn(),
  loggerSystem: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  exec: execMock,
}));
vi.mock('../../system/logger.js', () => ({
  logger: { warn: loggerWarn, system: loggerSystem, error: vi.fn(), debug: vi.fn(), agent: vi.fn(), plain: vi.fn() },
}));

import { runRepoPostCheckout } from '../post-checkout.js';

/** Make the mocked exec succeed (callback(null, {stdout, stderr})). */
function execSucceeds() {
  execMock.mockImplementation((_cmd: string, _opts: unknown, cb: (e: unknown, r: unknown) => void) => cb(null, { stdout: '', stderr: '' }));
}
/** Make the mocked exec fail (callback(err)). */
function execFails(msg: string) {
  execMock.mockImplementation((_cmd: string, _opts: unknown, cb: (e: unknown) => void) => cb(new Error(msg)));
}

const SAVED = { v: undefined as string | undefined };
beforeEach(() => {
  SAVED.v = process.env.ARCHIE_REPO_POSTCHECKOUT;
  execMock.mockReset(); loggerWarn.mockReset(); loggerSystem.mockReset();
});
afterEach(() => {
  if (SAVED.v === undefined) delete process.env.ARCHIE_REPO_POSTCHECKOUT;
  else process.env.ARCHIE_REPO_POSTCHECKOUT = SAVED.v;
});

describe('runRepoPostCheckout', () => {
  it('is a no-op (never execs) when ARCHIE_REPO_POSTCHECKOUT is unset', async () => {
    delete process.env.ARCHIE_REPO_POSTCHECKOUT;
    await runRepoPostCheckout({ clonePath: '/clone', github: 'org/x', editAllowed: false });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('runs the operator command in the clone dir, passing repo context env', async () => {
    process.env.ARCHIE_REPO_POSTCHECKOUT = 'npx ai-context sync';
    execSucceeds();
    await runRepoPostCheckout({ clonePath: '/clone', github: 'org/x', editAllowed: true });
    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, opts] = execMock.mock.calls[0];
    expect(cmd).toBe('npx ai-context sync');
    expect(opts.cwd).toBe('/clone');
    expect(opts.env.ARCHIE_POSTCHECKOUT_REPO).toBe('org/x');
    expect(opts.env.ARCHIE_POSTCHECKOUT_EDIT_MODE).toBe('1');
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('is best-effort: a failing command is warn-logged and does NOT throw', async () => {
    process.env.ARCHIE_REPO_POSTCHECKOUT = 'false';
    execFails('command failed: exit 1');
    await expect(runRepoPostCheckout({ clonePath: '/clone', github: 'org/x', editAllowed: false })).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith('agent', expect.stringContaining('post-checkout hook failed'));
  });

  it('marks edit mode 0 for a read-only agent', async () => {
    process.env.ARCHIE_REPO_POSTCHECKOUT = 'true';
    execSucceeds();
    await runRepoPostCheckout({ clonePath: '/c', github: 'org/y', editAllowed: false });
    expect(execMock.mock.calls[0][1].env.ARCHIE_POSTCHECKOUT_EDIT_MODE).toBe('0');
  });
});
