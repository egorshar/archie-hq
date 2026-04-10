/**
 * Recent Activity Index
 *
 * Manages workdir/memory/recent-activity.md — a markdown table
 * of the most recent completed tasks, newest first.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { getRecentActivityPath } from './paths.js';
import type { ActivityEntry } from './types.js';

const HEADER = `# Recent Activity

| Date | Task ID | Summary | Domain | User |
|------|---------|---------|--------|------|`;

const ROW_REGEX = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|$/;
const SEPARATOR_REGEX = /^\|[-\s|]+\|$/;

function parseRow(line: string): ActivityEntry | null {
  const match = ROW_REGEX.exec(line);
  if (!match) return null;

  const date = match[1].trim();
  // Skip header row and separator row
  if (date === 'Date' || date.startsWith('-')) return null;

  return {
    date,
    taskId: match[2].trim(),
    summary: match[3].trim(),
    domain: match[4].trim(),
    user: match[5].trim(),
  };
}

function entryToRow(entry: ActivityEntry): string {
  return `| ${entry.date} | ${entry.taskId} | ${entry.summary} | ${entry.domain} | ${entry.user} |`;
}

function buildFile(entries: ActivityEntry[]): string {
  const rows = entries.map(entryToRow).join('\n');
  return rows.length > 0 ? `${HEADER}\n${rows}\n` : `${HEADER}\n`;
}

/** Parse the markdown table and return all data entries. */
export async function readActivity(): Promise<ActivityEntry[]> {
  const path = getRecentActivityPath();
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return [];
  }

  const entries: ActivityEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = parseRow(line.trimEnd());
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Insert a new entry at the top of the table (newest first). Creates the file if it doesn't exist. */
export async function appendActivity(entry: ActivityEntry): Promise<void> {
  const path = getRecentActivityPath();
  await mkdir(dirname(path), { recursive: true });

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    // File doesn't exist — create fresh
    await writeFile(path, `${HEADER}\n${entryToRow(entry)}\n`, 'utf-8');
    return;
  }

  // Insert new row right after the separator line
  const lines = content.split('\n');
  const sepIndex = lines.findIndex((line) => SEPARATOR_REGEX.test(line.trimEnd()));

  if (sepIndex === -1) {
    // Malformed file — rewrite from scratch with only the new entry
    await writeFile(path, `${HEADER}\n${entryToRow(entry)}\n`, 'utf-8');
    return;
  }

  lines.splice(sepIndex + 1, 0, entryToRow(entry));
  await writeFile(path, lines.join('\n'), 'utf-8');
}

/** Keep only the newest maxEntries entries. Rewrites the file if trimming is needed. */
export async function trimActivity(maxEntries = 50): Promise<void> {
  const path = getRecentActivityPath();

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    // File doesn't exist — nothing to trim
    return;
  }

  const entries: ActivityEntry[] = [];
  for (const line of content.split('\n')) {
    const entry = parseRow(line.trimEnd());
    if (entry) entries.push(entry);
  }

  if (entries.length <= maxEntries) return;

  const trimmed = entries.slice(0, maxEntries);
  await writeFile(path, buildFile(trimmed), 'utf-8');
}
