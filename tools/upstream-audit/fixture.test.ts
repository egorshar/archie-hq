import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseUnifiedDiff } from './diff.js';
import { scanDiff } from './scan.js';

/**
 * A real slice of upstream drift (merge-base..upstream/main, 2026-07-29..2026-08-25)
 * for four files chosen to exercise both rule packs and the test-file suppression.
 *
 * Expectations below are read off the diff itself, not off the scanner's output:
 * the diff adds exactly one `getGitHubClient` import to production code
 * (src/agents/tools.ts) and one to a test file, touches spawn.ts and the GitHub
 * webhook ingress, and adds no octokit, SDK import, or `return tool(` line.
 */
const diff = readFileSync(new URL('./fixtures/upstream-delta.diff', import.meta.url), 'utf8');

describe('scanning real upstream drift', () => {
  const hits = scanDiff(parseUnifiedDiff(diff));

  test('finds the one production seam leak and nothing else of that rule', () => {
    const leaks = hits.filter((h) => h.ruleId === 'repo-host-leak');

    expect(leaks).toHaveLength(1);
    expect(leaks[0].file).toBe('src/agents/tools.ts');
    expect(leaks[0].evidence).toContain('getGitHubClient');
  });

  test('suppresses the identical import added to a test file', () => {
    expect(hits.filter((h) => h.file.includes('__tests__'))).toEqual([]);
  });

  test('flags the runtime-relevant agent surface and the webhook ingress', () => {
    expect(hits.filter((h) => h.ruleId === 'agent-surface-drift').map((h) => h.file)).toEqual([
      'src/agents/spawn.ts',
    ]);
    expect(hits.filter((h) => h.ruleId === 'webhook-drift').map((h) => h.file)).toEqual([
      'src/connectors/github/webhooks.ts',
    ]);
  });

  test('stays quiet on rules this slice does not trip', () => {
    const quiet = ['octokit-surface', 'sdk-leak', 'tool-registry-drift', 'github-env', 'github-connector-drift'];

    expect(hits.filter((h) => quiet.includes(h.ruleId))).toEqual([]);
  });
});
