/**
 * Build the transcript the title generator sees for a Slack thread. Per-message
 * redaction matches what the agent sees in knowledge.log — parity comes from
 * sharing `messageBody` and `shouldRedact`, which apply the same redaction policy
 * and the same body rendering as ingestion, rather than from this file
 * re-deriving either. Kept in the Slack layer so the generator itself is
 * channel-agnostic.
 */
import type { SlackThread } from '../../types/index.js';
import { messageBody, shouldRedact, REDACTION_PLACEHOLDER } from './message-body.js';

export function buildSlackTitleTranscript(thread: SlackThread): { transcript: string; hasUsableContent: boolean } {
  const lines: string[] = [];
  let hasUsableContent = false;

  for (const msg of thread.messages) {
    const redacted = shouldRedact(msg, thread);
    const body = messageBody(msg, thread);
    const author = redacted ? 'external' : msg.user.realName;
    lines.push(`[${author}]: ${body}`);
    if (!redacted && body.trim() !== '' && body !== REDACTION_PLACEHOLDER) {
      hasUsableContent = true;
    }
  }

  return { transcript: lines.join('\n'), hasUsableContent };
}
