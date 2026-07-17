import type { SlackAuthor } from '../types/task.js';

export type Requester = { id: string; name: string; source: 'slack' | 'cli' };

export type RequesterInput =
  | { kind: 'slack'; author: SlackAuthor }
  | { kind: 'cli' };

/** Resolve the task's requesting human, set-once: returns `current` unchanged if
 * already set, else derives it from the first human message. Slack → the
 * author's id + real name; CLI → a `cli` marker. */
export function captureRequester(current: Requester | undefined, input: RequesterInput): Requester | undefined {
  if (current) return current;
  if (input.kind === 'slack') {
    return { id: input.author.id, name: input.author.realName, source: 'slack' };
  }
  return { id: 'cli', name: 'cli', source: 'cli' };
}
