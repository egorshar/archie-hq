/**
 * Unit tests for buildPrCardBlocks — the Slack Block Kit rendering of a PR card
 * (linked title row + stats context line, with mrkdwn escaping).
 */

import { describe, it, expect } from 'vitest';
import type { PrCardData } from '../../../types/task.js';
import { buildPrCardBlocks } from '../client.js';

const baseCard: PrCardData = {
  repo: 'sweatco/archie-hq',
  prNumber: 482,
  url: 'https://github.com/sweatco/archie-hq/pull/482',
  title: 'Add response footer + PR cards',
  state: 'open',
  additions: 214,
  deletions: 38,
  changed_files: 7,
  head_sha: 'abc1234',
  ci: 'passed',
};

// Narrow the unknown[] blocks to the two shapes we assert on.
function parts(card: PrCardData) {
  const blocks = buildPrCardBlocks(card) as Array<{
    type: string;
    text?: { type: string; text: string };
    elements?: Array<{ type: string; text: string }>;
  }>;
  return { title: blocks[0].text!.text, stats: blocks[1].elements![0].text, blocks };
}

describe('buildPrCardBlocks', () => {
  it('renders a section title with the repo #number linked to the PR, and a context stats line', () => {
    const { title, stats, blocks } = parts(baseCard);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('section');
    expect(blocks[1].type).toBe('context');
    expect(title).toBe('🔀 <https://github.com/sweatco/archie-hq/pull/482|sweatco/archie-hq #482> — Add response footer + PR cards');
    expect(stats).toBe('+214 −38 · 7 files · ✅ checks passed');
  });

  it('uses the merged icon and failed-CI label for a merged PR with failing checks', () => {
    const { title, stats } = parts({ ...baseCard, state: 'merged', ci: 'failed' });
    expect(title).toMatch(/^🟣 </);
    expect(stats).toBe('+214 −38 · 7 files · ❌ checks failed');
  });

  it('omits the CI segment when there are no checks', () => {
    const { stats } = parts({ ...baseCard, ci: 'none' });
    expect(stats).toBe('+214 −38 · 7 files');
  });

  it('escapes mrkdwn-special characters in the title', () => {
    const { title } = parts({ ...baseCard, title: 'Fix <Foo> & <Bar>' });
    expect(title).toContain('Fix &lt;Foo&gt; &amp; &lt;Bar&gt;');
    expect(title).not.toContain('<Foo>');
  });
});
