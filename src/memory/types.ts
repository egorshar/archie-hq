/**
 * Memory Layer Types
 *
 * Self-contained types for the memory subsystem.
 * No imports from core types — keeps the dependency one-way.
 */

/** A single update to a memory file (org or user) */
export interface MemoryUpdate {
  action: 'add' | 'update';
  /** Section header to add under (e.g., "Engineering", "Communication") */
  section?: string;
  /** New content to add */
  content: string;
  /** For 'update': the old line to replace */
  old?: string;
}

/** Extraction result from the Sonnet side-agent */
export interface ExtractionResult {
  /** Updates to org.md */
  org_updates: MemoryUpdate[];
  /** Updates to user files, keyed by username */
  user_updates: Record<string, MemoryUpdate[]>;
  /** Structured task summary markdown */
  task_summary: string;
  /** One-line summary for recent-activity.md */
  activity_summary: string;
  /** Domain tag (engineering, marketing, operations, etc.) */
  domain: string;
}

/** A single row in recent-activity.md */
export interface ActivityEntry {
  date: string;
  taskId: string;
  summary: string;
  domain: string;
  user: string;
}
