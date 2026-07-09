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
