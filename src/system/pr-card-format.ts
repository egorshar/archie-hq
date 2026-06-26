/**
 * Pure formatting helpers for PR cards.
 *
 * Dependency-free (only a type import) so every surface can share it: the Slack
 * block builder, the CLI renderer, and the GitHub client's CI roll-up. Keeping
 * the text identical here is what makes the card look the same on Slack and the
 * CLI.
 */

import type { PrCardData } from '../types/task.js';

/** Leading state glyph: open / merged / closed. */
export function prCardStateIcon(state: PrCardData['state']): string {
  switch (state) {
    case 'merged': return '🟣';
    case 'closed': return '🚫';
    case 'open':
    default: return '🔀';
  }
}

/** Trailing CI label, or null when the PR has no checks (omitted from the card). */
export function ciLabel(ci: PrCardData['ci']): string | null {
  switch (ci) {
    case 'pending': return '⏳ checks running';
    case 'passed': return '✅ checks passed';
    case 'failed': return '❌ checks failed';
    case 'none':
    default: return null;
  }
}

/** Plain title line: `🔀 owner/name #482 — Title`. Slack links the `#num` separately. */
export function prCardTitleLine(card: PrCardData): string {
  return `${prCardStateIcon(card.state)} ${card.repo} #${card.prNumber} — ${card.title}`;
}

/** Stats line: `+214 −38 · 7 files · ✅ checks passed` (CI segment omitted when none). */
export function prCardStatsLine(card: PrCardData): string {
  const parts = [
    `+${card.additions} −${card.deletions}`,
    `${card.changed_files} ${card.changed_files === 1 ? 'file' : 'files'}`,
  ];
  const ci = ciLabel(card.ci);
  if (ci) parts.push(ci);
  return parts.join(' · ');
}

/**
 * Channel-agnostic change-detection key. When this differs from the last posted
 * card, the card is considered changed (resurface on PM turn-end / update in
 * place on a webhook).
 */
export function prCardFingerprint(card: PrCardData): string {
  return [card.state, card.additions, card.deletions, card.changed_files, card.head_sha, card.ci].join('|');
}

/**
 * Roll a list of checks up to a single CI verdict for the card.
 * Failure-class beats pending beats passed; no checks → `none`.
 * Accepts the minimal `{ status, conclusion }` shape so this stays free of
 * GitHub-client types.
 */
export function rollupCi(
  entries: ReadonlyArray<{ status: string; conclusion: string | null }>,
): PrCardData['ci'] {
  if (entries.length === 0) return 'none';
  const isFailure = (c: string | null) => c === 'failure' || c === 'timed_out' || c === 'action_required';
  const isPending = (e: { status: string; conclusion: string | null }) =>
    e.status !== 'completed' || e.conclusion === null;
  if (entries.some((e) => isFailure(e.conclusion))) return 'failed';
  if (entries.some(isPending)) return 'pending';
  return 'passed';
}
