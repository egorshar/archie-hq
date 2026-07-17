import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCommitTrailers, renderPrepareCommitMsgHook, writeCommitTrailerHook } from '../commit-trailers.js';

describe('buildCommitTrailers', () => {
  it('includes bot co-author and requested-by (slack shows @handle via id)', () => {
    const t = buildCommitTrailers(
      { name: 'Archie', email: 'archie@x.com' },
      { id: 'U1', name: 'Egor Sharapov', source: 'slack' },
    );
    expect(t).toContain('Co-Authored-By: Archie <archie@x.com>');
    expect(t.some((l) => l.startsWith('Requested-by: Egor Sharapov'))).toBe(true);
  });
  it('omits co-author when bot identity is absent; requested-by cli', () => {
    const t = buildCommitTrailers(null, { id: 'cli', name: 'cli', source: 'cli' });
    expect(t.every((l) => !l.startsWith('Co-Authored-By'))).toBe(true);
    expect(t).toContain('Requested-by: cli');
  });
  it('keeps every trailer on a single line even when a name carries newlines/tabs', () => {
    const t = buildCommitTrailers(
      { name: 'Archie', email: 'archie@x.com' },
      { id: 'U1', name: 'Egor\nSharapov\tJr', source: 'slack' },
    );
    // A trailer with an embedded newline would be split by `printf`/`grep -qxF`,
    // defeating idempotency — every rendered trailer must be exactly one line.
    expect(t.every((l) => !l.includes('\n'))).toBe(true);
    expect(t).toContain('Requested-by: Egor Sharapov Jr (@U1)');
  });
});

describe('prepare-commit-msg hook (real git)', () => {
  it('appends each trailer once and is idempotent across two commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archie-hook-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'bot@x.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'bot'], { cwd: dir });
    await writeCommitTrailerHook(dir, ['Co-Authored-By: Archie <a@x.com>', 'Requested-by: Egor Sharapov (@U1)']);
    await writeFile(join(dir, 'a.txt'), '1');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'first'], { cwd: dir });
    const msg1 = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: dir }).toString();
    expect(msg1).toContain('Requested-by: Egor Sharapov (@U1)');
    expect(msg1).toContain('Co-Authored-By: Archie <a@x.com>');
    execFileSync('git', ['commit', '--amend', '--no-edit'], { cwd: dir });
    const msg2 = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: dir }).toString();
    expect(msg2.match(/Requested-by:/g)?.length).toBe(1);
  });
});
