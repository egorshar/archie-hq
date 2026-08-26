import { describe, expect, test } from 'vitest';
import type { ChangedFile } from './diff.js';
import { RULES } from './rules.js';
import { scanDiff } from './scan.js';

const repoHostLeak = RULES.filter((r) => r.id === 'repo-host-leak');

function file(path: string, ...added: string[]): ChangedFile {
  return {
    path,
    status: 'modified',
    addedLines: added.map((text, i) => ({ line: i + 1, text })),
  };
}

const LEAK = "import { getGitHubClient } from '../connectors/github/client.js';";

describe('repo-host-leak', () => {
  test('flags a new getGitHubClient call site in production code', () => {
    const hits = scanDiff([file('src/agents/tools.ts', LEAK)], repoHostLeak);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleId: 'repo-host-leak',
      pack: 'gitlab',
      file: 'src/agents/tools.ts',
      line: 1,
      evidence: LEAK,
    });
  });

  test('ignores test files, which mock the client instead of calling it', () => {
    const hits = scanDiff([file('src/agents/__tests__/pr-tools.test.ts', LEAK)], repoHostLeak);

    expect(hits).toEqual([]);
  });

  test('ignores backends.ts, the sanctioned place where the adapter is built', () => {
    const hits = scanDiff([file('src/system/backends.ts', LEAK)], repoHostLeak);

    expect(hits).toEqual([]);
  });

  test('ignores the github connector itself', () => {
    const hits = scanDiff([file('src/connectors/github/merge.ts', LEAK)], repoHostLeak);

    expect(hits).toEqual([]);
  });
});
