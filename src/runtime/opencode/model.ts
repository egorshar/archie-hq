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
 * The server-global model route as a `provider/model` string, for the footer.
 * config.model is server-wide in opencode (spike.md §5), so this reflects the
 * single default route. Returns null when unresolved (never throws — the footer
 * is best-effort). modelDisplayLabel() beautifies the `anthropic/claude-*` shape.
 */
export function opencodeFooterModel(): string | null {
  try {
    const m = resolveOpencodeModel('default');
    return `${m.providerID}/${m.modelID}`;
  } catch {
    return null;
  }
}
