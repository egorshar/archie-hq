/**
 * Unit tests for the pure PR-card formatting helpers: CI roll-up, fingerprint
 * change-detection, and the title/stats text shared by Slack and the CLI.
 */

import { describe, it, expect } from 'vitest';
import type { PrCardData } from '../../types/task.js';
import {
  rollupCi,
  prCardFingerprint,
  prCardStatsLine,
  prCardTitleLine,
  prCardStateIcon,
  ciLabel,
} from '../pr-card-format.js';

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

const completed = (conclusion: string | null) => ({ status: 'completed', conclusion });

describe('rollupCi', () => {
  it('returns none when there are no checks', () => {
    expect(rollupCi([])).toBe('none');
  });

  it('returns passed when all checks succeeded (success/skipped/neutral)', () => {
    expect(rollupCi([completed('success'), completed('skipped'), completed('neutral')])).toBe('passed');
  });

  it('returns failed when any check is a failure class', () => {
    expect(rollupCi([completed('success'), completed('failure')])).toBe('failed');
    expect(rollupCi([completed('timed_out')])).toBe('failed');
    expect(rollupCi([completed('action_required')])).toBe('failed');
  });

  it('returns pending when a check is still running and none have failed', () => {
    expect(rollupCi([completed('success'), { status: 'in_progress', conclusion: null }])).toBe('pending');
    expect(rollupCi([completed(null)])).toBe('pending'); // completed but no conclusion yet
  });

  it('prefers failed over pending', () => {
    expect(rollupCi([completed('failure'), { status: 'queued', conclusion: null }])).toBe('failed');
  });
});

describe('prCardFingerprint', () => {
  it('is stable for identical cards and changes on any tracked field', () => {
    const fp = prCardFingerprint(baseCard);
    expect(prCardFingerprint({ ...baseCard })).toBe(fp);
    expect(prCardFingerprint({ ...baseCard, ci: 'failed' })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, additions: 215 })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, state: 'merged' })).not.toBe(fp);
    expect(prCardFingerprint({ ...baseCard, head_sha: 'def5678' })).not.toBe(fp);
  });

  it('ignores fields that do not affect the card (title, url)', () => {
    const fp = prCardFingerprint(baseCard);
    expect(prCardFingerprint({ ...baseCard, title: 'Renamed' })).toBe(fp);
    expect(prCardFingerprint({ ...baseCard, url: 'https://example.com' })).toBe(fp);
  });
});

describe('prCardStatsLine', () => {
  it('renders adds/dels, file count, and CI label', () => {
    expect(prCardStatsLine(baseCard)).toBe('+214 −38 · 7 files · ✅ checks passed');
  });

  it('uses singular "file" for one changed file', () => {
    expect(prCardStatsLine({ ...baseCard, changed_files: 1 })).toBe('+214 −38 · 1 file · ✅ checks passed');
  });

  it('omits the CI segment when there are no checks', () => {
    expect(prCardStatsLine({ ...baseCard, ci: 'none' })).toBe('+214 −38 · 7 files');
  });

  it('shows the failed CI label', () => {
    expect(prCardStatsLine({ ...baseCard, ci: 'failed' })).toBe('+214 −38 · 7 files · ❌ checks failed');
  });
});

describe('prCardStateIcon / prCardTitleLine / ciLabel', () => {
  it('uses a distinct icon per state', () => {
    expect(prCardStateIcon('open')).toBe('🔀');
    expect(prCardStateIcon('merged')).toBe('🟣');
    expect(prCardStateIcon('closed')).toBe('🚫');
  });

  it('builds the plain title line', () => {
    expect(prCardTitleLine(baseCard)).toBe('🔀 sweatco/archie-hq #482 — Add response footer + PR cards');
    expect(prCardTitleLine({ ...baseCard, state: 'merged' })).toBe('🟣 sweatco/archie-hq #482 — Add response footer + PR cards');
  });

  it('returns null CI label when there are no checks', () => {
    expect(ciLabel('none')).toBeNull();
    expect(ciLabel('pending')).toBe('⏳ checks running');
  });
});
