/**
 * Resolve a logical model name (as the LlmOneShot callers pass — 'haiku',
 * 'sonnet', …) to an opencode { providerID, modelID }.
 *
 * Resolution order:
 *   1. `provider/model` passthrough when the name already contains '/'.
 *   2. env `ARCHIE_OPENCODE_MODEL_<UPPER(name)>` (value is `provider/model`).
 *   3. env `ARCHIE_OPENCODE_MODEL_DEFAULT`.
 *   4. throw — no wrong-model guessing; the message names the env vars to set.
 */

export interface OpencodeModelRef {
  providerID: string;
  modelID: string;
}

function splitRef(spec: string): OpencodeModelRef {
  const idx = spec.indexOf('/');
  return { providerID: spec.slice(0, idx), modelID: spec.slice(idx + 1) };
}

export function resolveOpencodeModel(model: string): OpencodeModelRef {
  if (model.includes('/')) return splitRef(model);

  const perLogical = process.env[`ARCHIE_OPENCODE_MODEL_${model.toUpperCase()}`];
  if (perLogical && perLogical.includes('/')) return splitRef(perLogical);

  const fallback = process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
  if (fallback && fallback.includes('/')) return splitRef(fallback);

  throw new Error(
    `Cannot resolve opencode model for "${model}". Set ARCHIE_OPENCODE_MODEL_${model.toUpperCase()} ` +
      `or ARCHIE_OPENCODE_MODEL_DEFAULT to a "provider/model" id (e.g. anthropic/claude-haiku-4-5).`,
  );
}

/**
 * A real opencode route can wrap the underlying claude id behind provider
 * segments — e.g. `openrouter/anthropic/claude-haiku-4-5` (providerID
 * `openrouter`, modelID `anthropic/claude-haiku-4-5`, since resolveOpencodeModel
 * splits at only the FIRST `/`). `modelDisplayLabel`'s beautify() only strips a
 * leading `^(anthropic\/)?claude-`, so anything before that (`openrouter/`)
 * would otherwise pass through raw in the footer. Matches from wherever the
 * `(anthropic/)?claude-` shape starts, to the end of the string.
 */
const CLAUDE_ID_IN_ROUTE_RE = /(anthropic\/)?claude-.*/;

/**
 * The server-global model route as a `provider/model` string, for the footer.
 * config.model is server-wide in opencode (spike.md §5), so this reflects the
 * single default route. Returns null when unresolved (never throws — the footer
 * is best-effort). When the route contains a claude id, this trims any
 * provider-wrapper prefix so it begins at `anthropic/claude-`/`claude-`, letting
 * modelDisplayLabel() beautify it (e.g. `openrouter/anthropic/claude-haiku-4-5`
 * → `anthropic/claude-haiku-4-5` → beautifies to `Haiku 4.5`). Non-claude routes
 * (e.g. `openrouter/openai/gpt-4o`) pass through unchanged.
 */
export function opencodeFooterModel(): string | null {
  try {
    const m = resolveOpencodeModel('default');
    const route = `${m.providerID}/${m.modelID}`;
    const match = CLAUDE_ID_IN_ROUTE_RE.exec(route);
    return match ? match[0] : route;
  } catch {
    return null;
  }
}
