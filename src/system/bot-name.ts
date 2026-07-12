/**
 * The bot's public-facing persona name.
 *
 * Single source of truth for what the assistant calls itself in prompts and
 * user-facing copy. Set `BOT_NAME` in the environment to rename it (default
 * "Archie"). NOTE: this controls the *persona / text* only — the name Slack
 * displays (message sender, the "… is thinking" status prefix) comes from the
 * Slack app's display name in `slack-manifest.yaml`. Keep the two in sync.
 */
export function botName(): string {
  return process.env.BOT_NAME?.trim() || 'Archie';
}
