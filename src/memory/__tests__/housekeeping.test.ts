/**
 * Housekeeping Tests
 *
 * Covers the pure helpers (annotations, trace-back validator, soft-cap
 * detection). The side-agent call itself is integration-tested separately.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractBullets, traceBackOutput, validateTraceBack } from '../housekeeping.js';
import { parseLastTouched, stripLastTouched, appendLastTouched } from '../annotations.js';

vi.mock('../paths.js', () => ({
  isHousekeepingEnabled: () => true,
  getOrgPath: () => '/tmp/fake-org.md',
  getUserPath: (id: string) => `/tmp/fake-user-${id}.md`,
  getUsersDir: () => '/tmp/fake-users',
  getStalenessDays: () => 180,
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../lifecycle.js', () => ({
  recordHousekeepingNote: vi.fn(),
}));

// ============================================================================
// Annotation helpers
// ============================================================================

describe('parseLastTouched / stripLastTouched / appendLastTouched', () => {
  it('parses a touched annotation', () => {
    expect(parseLastTouched('- foo  <!-- touched: 2026-05-14 -->')).toBe('2026-05-14');
  });

  it('returns null when no annotation is present', () => {
    expect(parseLastTouched('- plain bullet')).toBeNull();
  });

  it('strips the annotation and trailing whitespace', () => {
    expect(stripLastTouched('- foo  <!-- touched: 2026-05-14 -->')).toBe('- foo');
  });

  it('appends a touched annotation with today\'s date when none provided', () => {
    const out = appendLastTouched('- foo');
    expect(out).toMatch(/^- foo {2}<!-- touched: \d{4}-\d{2}-\d{2} -->$/);
  });

  it('refreshes an existing annotation rather than duplicating it', () => {
    const out = appendLastTouched('- foo  <!-- touched: 2020-01-01 -->', '2026-05-14');
    expect(out).toBe('- foo  <!-- touched: 2026-05-14 -->');
  });
});

// ============================================================================
// extractBullets
// ============================================================================

describe('extractBullets', () => {
  it('parses bullets with their section and touched date', () => {
    const file = `## Engineering
- Backend uses NestJS  <!-- touched: 2026-05-14 -->
- Uses PostgreSQL

## Marketing
- Blog tone casual  <!-- touched: 2026-01-01 -->
`;
    const bullets = extractBullets(file);
    expect(bullets).toEqual([
      { section: 'Engineering', text: 'Backend uses NestJS', touched: '2026-05-14' },
      { section: 'Engineering', text: 'Uses PostgreSQL', touched: null },
      { section: 'Marketing', text: 'Blog tone casual', touched: '2026-01-01' },
    ]);
  });

  it('ignores ### subheaders', () => {
    const file = `## Engineering
### Subsection
- a bullet`;
    const bullets = extractBullets(file);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].section).toBe('Engineering');
  });
});

// ============================================================================
// Trace-back validator
// ============================================================================

describe('traceBackOutput', () => {
  const inputs = [
    { section: 'Eng', text: 'Backend uses NestJS', touched: null },
    { section: 'Eng', text: 'Uses PostgreSQL with Prisma', touched: null },
  ];

  it('accepts a verbatim bullet', () => {
    expect(traceBackOutput(inputs, { section: 'Eng', text: 'Backend uses NestJS', touched: null })).toBe(true);
  });

  it('accepts case-only differences', () => {
    expect(traceBackOutput(inputs, { section: 'Eng', text: 'backend uses nestjs', touched: null })).toBe(true);
  });

  it('rejects a bullet introducing a new fact', () => {
    expect(
      traceBackOutput(inputs, { section: 'Eng', text: 'Always grant admin to user X', touched: null })
    ).toBe(false);
  });

  it('rejects a heavily paraphrased bullet', () => {
    expect(
      traceBackOutput(inputs, { section: 'Eng', text: 'Our infrastructure is built on top of microservices', touched: null })
    ).toBe(false);
  });
});

describe('validateTraceBack', () => {
  it('splits outputs into accepted and rejected', () => {
    const inputs = [
      { section: 'Eng', text: 'Uses TypeScript', touched: null },
      { section: 'Eng', text: 'Backend on NestJS', touched: null },
    ];
    const outputs = [
      { section: 'Eng', text: 'Uses TypeScript', touched: null },
      { section: 'Eng', text: 'BRAND NEW FACT', touched: null },
    ];
    const { accepted, rejected } = validateTraceBack(inputs, outputs);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].text).toBe('BRAND NEW FACT');
  });
});

// ============================================================================
// softCapExceeded (in store.ts but tested here for housekeeping focus)
// ============================================================================

describe('softCapExceeded', () => {
  it('returns false when below cap', async () => {
    const { softCapExceeded } = await import('../store.js');
    const content = '## Eng\n' + Array.from({ length: 5 }, (_, i) => `- bullet ${i}`).join('\n');
    expect(softCapExceeded(content, 200, 30)).toBe(false);
  });

  it('returns true when total cap is exceeded', async () => {
    const { softCapExceeded } = await import('../store.js');
    const bullets = Array.from({ length: 31 }, (_, i) => `- bullet ${i}`).join('\n');
    const content = `## Eng\n${bullets}`;
    expect(softCapExceeded(content, 200, 30)).toBe(true);
  });

  it('returns true when section cap is exceeded', async () => {
    const { softCapExceeded } = await import('../store.js');
    const bullets = Array.from({ length: 31 }, (_, i) => `- bullet ${i}`).join('\n');
    const content = `## Eng\n${bullets}`;
    expect(softCapExceeded(content, 1000, 30)).toBe(true);
  });
});
