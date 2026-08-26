import type { Violation } from './invariants.js';
import type { Hit } from './scan.js';
import type { RulePack } from './rules.js';

export interface ReportInput {
  range: string;
  hits: Hit[];
  violations: Violation[];
}

const PACKS: Array<{ pack: RulePack; title: string; empty: string }> = [
  {
    pack: 'gitlab',
    title: '## GitLab repo host',
    empty: 'No GitLab-relevant changes in this range.',
  },
  {
    pack: 'opencode',
    title: '## opencode runtime',
    empty: 'No opencode-relevant changes in this range.',
  },
];

function location(hit: Hit): string {
  return hit.line === undefined ? hit.file : `${hit.file}:${hit.line}`;
}

function packSection(pack: RulePack, hits: Hit[]): string[] {
  const rows = hits.filter((h) => h.pack === pack);
  const meta = PACKS.find((p) => p.pack === pack)!;
  if (rows.length === 0) return [meta.title, '', meta.empty, ''];

  return [
    meta.title,
    '',
    '| Rule | Upstream change | Verdict | Why it may matter | Look at |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (h) => `| \`${h.ruleId}\` | \`${location(h)}\` |  | ${h.why} | ${h.lookAt.map((l) => `\`${l}\``).join(', ')} |`,
    ),
    '',
  ];
}

function invariantSection(violations: Violation[]): string[] {
  if (violations.length === 0) {
    return ['## Seam invariants', '', 'Seam invariants hold: no direct backend access outside its adapter.', ''];
  }

  return [
    '## Seam invariants — VIOLATED',
    '',
    '| Invariant | Location | Evidence | Why |',
    '| --- | --- | --- | --- |',
    ...violations.map(
      (v) => `| \`${v.invariantId}\` | \`${v.file}:${v.line}\` | \`${v.evidence}\` | ${v.why} |`,
    ),
    '',
  ];
}

export function renderReport({ range, hits, violations }: ReportInput): string {
  return [
    '# Upstream audit',
    '',
    `Range: \`${range}\``,
    '',
    'Each row is a tripwire, not a verdict. Fill the Verdict column during triage:',
    '`needs-work` / `no-op` / `unsure`, with the fork-side file to change.',
    '',
    ...invariantSection(violations),
    ...packSection('gitlab', hits),
    ...packSection('opencode', hits),
  ].join('\n');
}
