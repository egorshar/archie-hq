import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { startEmbeddedServer } from '../embedded-server.js';

function fakeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.resume = vi.fn();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('startEmbeddedServer handle surface (P3a)', () => {
  it('resolves with the parsed url and fires onExit when the child dies post-start (A5)', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const p = startEmbeddedServer({ cwd: '/tmp/x', config: {} });
    proc.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4545\n'));
    const server = await p;
    expect(server.url).toBe('http://127.0.0.1:4545');

    const exited = vi.fn();
    server.onExit(exited);
    proc.emit('exit', 0);
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it('rejects on pre-start exit', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const p = startEmbeddedServer({ cwd: '/tmp/x', config: {} });
    proc.emit('exit', 1);
    await expect(p).rejects.toThrow(/exited/);
  });
});
