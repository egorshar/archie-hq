/**
 * Memory Context Builder
 *
 * Assembles memory artifacts into XML-tagged context blocks
 * for injection into agent system prompts.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { readOrg, readUser } from './store.js';
import { isMemoryEnabled, getRecentActivityPath } from './paths.js';
import type { UserRef } from './types.js';

/**
 * Build an XML-tagged memory context string from available memory artifacts.
 *
 * - org.md → <organizational_knowledge> block
 * - per-user files → <user_preferences user_id="..." display_name="..."> blocks
 * - recent-activity.md → <recent_activity> block
 *
 * `users` is the set of users involved in the current task; if empty, no
 * per-user blocks are emitted. The legacy string-array shape is also accepted
 * for callers that haven't been migrated yet.
 *
 * Blocks are joined with double newlines. Returns '' when nothing is available.
 */
export async function buildMemoryContext(users: UserRef[] | string[]): Promise<string> {
  const blocks: string[] = [];

  // Org knowledge
  const orgContent = await readOrg();
  if (orgContent.trim()) {
    blocks.push(`<organizational_knowledge>\n${orgContent.trimEnd()}\n</organizational_knowledge>`);
  }

  // Per-user preferences
  const refs: UserRef[] = users.map((u) =>
    typeof u === 'string' ? { userId: u, displayName: u } : u
  );
  for (const ref of refs) {
    let userContent: string;
    try {
      userContent = await readUser(ref.userId);
    } catch {
      // Invalid ID shape — skip rather than crash the prompt build
      continue;
    }
    if (userContent.trim()) {
      const display = ref.displayName !== ref.userId ? ` display_name="${escapeAttr(ref.displayName)}"` : '';
      blocks.push(
        `<user_preferences user_id="${escapeAttr(ref.userId)}"${display}>\n${userContent.trimEnd()}\n</user_preferences>`
      );
    }
  }

  // Recent activity
  const activityPath = getRecentActivityPath();
  if (existsSync(activityPath)) {
    const activityContent = await readFile(activityPath, 'utf-8');
    if (activityContent.trim()) {
      blocks.push(`<recent_activity>\n${activityContent.trimEnd()}\n</recent_activity>`);
    }
  }

  return blocks.join('\n\n');
}

/**
 * Enrich a system prompt with organizational memory context.
 *
 * If memory is disabled or there is no memory content, returns the prompt unchanged.
 * Otherwise appends the context under an "Organizational Memory" header.
 */
export async function enrichPromptWithMemory(
  systemPrompt: string,
  users: UserRef[] | string[],
): Promise<string> {
  if (!isMemoryEnabled()) {
    return systemPrompt;
  }

  const memoryContext = await buildMemoryContext(users);
  if (!memoryContext) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## Organizational Memory\n\nThe following is what you know from previous tasks. Use this to inform your work.\n\n${memoryContext}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
