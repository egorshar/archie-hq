/**
 * LlmOneShot — a plain one-shot LLM call (spec §3.4): prompt in → text/JSON out.
 * Used by title generation, memory extraction/housekeeping, and (disabled)
 * triage. Claude-SDK impl today; opencode impl in Phase 2.
 */

export interface LlmTextRequest {
  prompt: string;
  systemPrompt?: string;
  /** runtime-specific model id resolved by the caller for now ('haiku' | 'sonnet' | …). */
  model: string;
  maxTurns?: number;
  /** built-in tools to allow (triage allows Glob/Grep/Read); default none. */
  allowedTools?: string[];
  /** working directory for the one-shot process (triage uses the sessions dir). */
  cwd?: string;
  /** optional stderr sink for debug (extractor/housekeeping). */
  stderr?: (data: string) => void;
}

export interface LlmJsonRequest extends LlmTextRequest {
  /** caller-built JSON Schema for structured output. Caller validates the result itself. */
  jsonSchema: Record<string, unknown>;
}

export interface LlmOneShot {
  readonly kind: 'claude' | 'opencode';
  /** Free-text completion. Returns final text, or null on failure/non-success. */
  text(req: LlmTextRequest): Promise<string | null>;
  /** Structured completion. Returns the raw structured output (caller validates), or null. */
  json(req: LlmJsonRequest): Promise<unknown | null>;
}
