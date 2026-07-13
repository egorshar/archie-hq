/**
 * Build the transcript the title generator sees for a Slack thread. Per-message
 * redaction matches what the agent sees in knowledge.log (shared helper
 * renderMessageForContext). Kept in the Slack layer so the generator itself is
 * channel-agnostic.
 */
import type { SlackThread } from '../../types/index.js';
import { renderMessageForContext } from '../../tasks/persistence.js';
import { isExternalUser } from './client.js';

const REDACTION_PLACEHOLDER = '[redacted: external participant in shared channel]';

export function buildSlackTitleTranscript(thread: SlackThread): { transcript: string; hasUsableContent: boolean } {
  const lines: string[] = [];
  let hasUsableContent = false;

  for (const msg of thread.messages) {
    const redacted = thread.shared && isExternalUser(msg.user);
    const body = renderMessageForContext(msg, { redacted });
    const author = redacted ? 'external' : msg.user.realName;
    lines.push(`[${author}]: ${body}`);
    if (!redacted && body.trim() !== '' && body !== REDACTION_PLACEHOLDER) {
      hasUsableContent = true;
    }
  }

  return { transcript: lines.join('\n'), hasUsableContent };
}
