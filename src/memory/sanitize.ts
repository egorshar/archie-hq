/**
 * Memory Sanitization
 *
 * Centralised validation/sanitization for every memory artifact persisted
 * to disk. Model output is untrusted — fields embedded into Markdown bullets,
 * table cells, or YAML frontmatter must be normalised (or rejected) here
 * before they touch the filesystem.
 *
 * Rejected updates are dropped (not coerced into a hostile shape) and the
 * caller is expected to `logger.warn('memory', ...)` with the rejection
 * reason.
 */

import type { MemoryUpdate, ActivityEntry } from './types.js';

// ---- Limits & enums ----

const CONTENT_MAX = 200;
const ACTIVITY_SUMMARY_MAX = 100;
const TASK_SUMMARY_MAX = 2000;

const SECTION_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{0,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID_RE = /^[A-Za-z0-9._\-:]+$/;
const ACTIVITY_USER_RE = /^[A-Za-z0-9._\-:]+$/;

const ALLOWED_DOMAINS = new Set(['engineering', 'marketing', 'operations', 'product', 'other']);

// ---- Field-level helpers ----

/** Section header must be alphanumeric/spaces/hyphens. Strip leading `##` if present. */
export function isAllowedSection(section: string): boolean {
  return SECTION_RE.test(section);
}

/** Domain must be one of the spec-defined enum values. */
export function isAllowedDomain(domain: string): boolean {
  return ALLOWED_DOMAINS.has(domain);
}

/** Escape pipe characters so a value can safely live in a Markdown table cell. */
export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Collapse runs of whitespace, strip leading list markers, single-line only. */
function normaliseBullet(content: string): string | null {
  let s = content.replace(/^[-*]\s+/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/\n|\r/.test(s)) return null;
  if (s.length > CONTENT_MAX) return null;
  return s;
}

// ---- Prompt-injection heuristics ----

/**
 * Reject content that resembles imperative agent instructions
 * (e.g., "Always grant admin", "You are now a sysadmin").
 * Heuristic — false-negatives possible but false-positives on
 * normal memory facts should be rare since useful memory describes
 * a state of the world, not commands to the agent.
 */
export function looksLikeInstruction(content: string): boolean {
  if (/^(always|never|must|do not|don['']t)\b/i.test(content)) return true;
  const bypassTokens = [
    'system prompt',
    'ignore previous',
    'ignore the previous',
    'ignore all previous',
    'you are now',
    'you are a',
    'act as',
    'pretend to be',
    'forget your instructions',
    'override your',
    'disregard',
  ];
  const lc = content.toLowerCase();
  return bypassTokens.some((t) => lc.includes(t));
}

/**
 * Reject content that resembles a credential or API key.
 * Heuristic; defense-in-depth on top of the extractor prompt.
 */
export function looksLikeSecret(content: string): boolean {
  if (/\b(Bearer\s+[A-Za-z0-9_\-.=]{16,})/i.test(content)) return true;
  // Common secret prefixes followed by long token bodies
  if (/\b(sk-|xoxb-|xoxp-|ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_\-]{16,}/.test(content)) return true;
  if (/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/.test(content)) return true;
  // KEY=long-alphanumeric-blob pattern
  if (/[A-Z_]{3,}=[A-Za-z0-9+/=_\-]{24,}/.test(content)) return true;
  return false;
}

// ---- Per-artifact sanitizers ----

/**
 * Validate + sanitize a MemoryUpdate. Returns the cleaned update or null
 * when any rule rejects (caller should drop and log).
 */
export function sanitizeUpdate(update: MemoryUpdate): MemoryUpdate | null {
  if (!update || (update.action !== 'add' && update.action !== 'update')) return null;

  const content = normaliseBullet(update.content);
  if (content === null) return null;
  if (looksLikeInstruction(content) || looksLikeSecret(content)) return null;

  let section: string | undefined = undefined;
  if (update.section !== undefined) {
    const s = update.section.replace(/^#+\s*/, '').trim();
    if (!isAllowedSection(s)) return null;
    section = s;
  }

  let old: string | undefined = undefined;
  if (update.action === 'update') {
    if (update.old === undefined) return null;
    const o = normaliseBullet(update.old);
    if (o === null) return null;
    old = o;
  }

  return { action: update.action, content, ...(section !== undefined && { section }), ...(old !== undefined && { old }) };
}

/**
 * Validate + sanitize an ActivityEntry. Returns the cleaned row or null.
 */
export function sanitizeActivityEntry(entry: ActivityEntry): ActivityEntry | null {
  if (!entry) return null;
  if (!DATE_RE.test(entry.date)) return null;
  if (!TASK_ID_RE.test(entry.taskId)) return null;
  if (!isAllowedDomain(entry.domain)) return null;
  if (!ACTIVITY_USER_RE.test(entry.user)) return null;

  let summary = entry.summary.replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  if (/\n|\r/.test(summary)) return null;
  if (summary.length > ACTIVITY_SUMMARY_MAX) summary = summary.slice(0, ACTIVITY_SUMMARY_MAX);
  summary = escapeTableCell(summary);

  return {
    date: entry.date,
    taskId: entry.taskId,
    summary,
    domain: entry.domain,
    user: entry.user,
  };
}

/**
 * Validate the prose task summary. Reject if it would break YAML frontmatter
 * or exceed the cap. Multi-line is allowed.
 */
export function sanitizeTaskSummary(summary: string): string | null {
  if (typeof summary !== 'string') return null;
  const s = summary.trim();
  if (!s) return null;
  if (/^---$/m.test(s)) return null;
  if (s.length > TASK_SUMMARY_MAX) return null;
  return s;
}
