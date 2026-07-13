/**
 * Title Generator
 *
 * Generates a concise, AI-authored title for a task from a transcript of its
 * opening conversation. Channel-agnostic: callers build the transcript (Slack
 * applies its own redaction; the CLI passes the user's message). Single haiku
 * one-shot (getLlmOneShot().json) with structured JSON output. Best-effort —
 * returns null on any failure (logged, not thrown); callers fall back to
 * channel_name.
 */
import { z, toJSONSchema } from 'zod';
import type { Task } from './task.js';
import { logger } from '../system/logger.js';
import { getLlmOneShot } from '../system/backends.js';

const TitleSchema = z.object({ title: z.string() });
const rawTitleSchema = toJSONSchema(TitleSchema) as Record<string, unknown>;
const { $schema: _drop, ...titleJsonSchema } = rawTitleSchema;

const SYSTEM_PROMPT = `You generate a concise title for a task based on the initial conversation that started it.

Rules:
- Maximum 60 characters
- Free-form style (imperative, noun phrase, question — whatever fits)
- No quotes, no trailing punctuation
- Match the conversation's primary language
- Capture the actual subject, not generic phrases

Respond with JSON only.`;

function cleanTitle(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  const quotePairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (const [open, close] of quotePairs) {
    if (t.startsWith(open) && t.endsWith(close) && t.length >= 2) {
      t = t.slice(1, -1).trim();
      break;
    }
  }
  t = t.replace(/[.!?…]+$/u, '').trim();
  if (!t) return null;
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t || null;
}

/**
 * Generate a title from a plain transcript. Returns null on a blank transcript,
 * a failed/malformed one-shot, or an empty cleaned title.
 */
export async function generateTitle(transcript: string): Promise<string | null> {
  try {
    if (!transcript || !transcript.trim()) return null;

    const prompt = `Generate a concise title for the following conversation.

${transcript}

Respond with JSON only.`;

    const raw = await getLlmOneShot().json({
      prompt,
      model: 'haiku',
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 2,
      jsonSchema: titleJsonSchema,
    });
    if (!raw) {
      logger.warn('title-generator', 'haiku call failed');
      return null;
    }
    const parsed = TitleSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('title-generator', `schema validation failed: ${parsed.error.message}`);
      return null;
    }
    return cleanTitle(parsed.data.title);
  } catch (err) {
    logger.warn('title-generator', `unexpected failure: ${err}`);
    return null;
  }
}

/**
 * Generate a title from `transcript` and, on success, set it on the task and
 * persist. Returns the applied title (or null). Best-effort — callers invoke it
 * fire-and-forget, guarded by `!task.metadata.title`.
 */
export async function applyGeneratedTitle(task: Task, transcript: string): Promise<string | null> {
  const title = await generateTitle(transcript);
  if (!title) return null;
  task.metadata.title = title;
  task.debouncedSave();
  logger.system(`Task ${task.taskId} title set: "${title}"`);
  return title;
}
