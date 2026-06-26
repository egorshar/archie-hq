/**
 * Human-friendly model labels for the message footer.
 *
 * The app passes short aliases (`opus`, `sonnet`, `haiku`) to the Claude Agent
 * SDK, optionally suffixed with `[1m]` to enable the 1M context window (the SDK
 * strips the suffix and adds the `context-1m` beta — see `spawn.ts`). For the
 * footer we resolve the alias to its current full model id and re-attach the
 * suffix, so `sonnet[1m]` reads as `claude-sonnet-4-6[1m]`. Any already-full id
 * (or unknown alias) passes through unchanged.
 */

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

/**
 * Resolve a model string (as passed to the SDK) to its display label,
 * preserving a trailing `[1m]` 1M-context marker when present.
 */
export function modelDisplayLabel(model: string): string {
  const trimmed = (model || '').trim();
  // Split off a trailing `[1m]` (case-insensitive) so we can map the base alias
  // and re-attach the marker afterwards.
  const match = /^(.*?)\s*(\[1m\])$/i.exec(trimmed);
  const base = match ? match[1] : trimmed;
  const suffix = match ? '[1m]' : '';
  const display = MODEL_DISPLAY_NAMES[base.toLowerCase()] ?? base;
  return `${display}${suffix}`;
}
