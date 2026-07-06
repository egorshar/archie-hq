/**
 * ClaudeLlmOneShot — one-shot LLM calls via the Claude Agent SDK query() (spec
 * §3.4). Consolidates the env allowlist + event-loop plumbing that title
 * generation, memory extraction/housekeeping, and triage each hand-rolled.
 * Callers keep their own schema construction + downstream validation, so
 * behavior is identical to the pre-consolidation call sites.
 *
 * text() accumulation mirrors extractor.ts/housekeeping.ts exactly: collect
 * `text` blocks from `assistant` events' `message.content[]`, then override
 * with the `result` event's `result` string on `subtype: 'success'` — but
 * only when that string is non-empty after trimming (matching the real
 * `typeof r === 'string' && r.trim()` guard). Returns null when nothing
 * usable accumulated.
 *
 * json() mirrors title-generator.ts/triage.ts exactly: on the first `result`
 * event with `subtype: 'success'`, return the raw `structured_output`
 * (caller re-validates with its own zod schema); any other subtype yields
 * null.
 */

import type { LlmOneShot, LlmTextRequest, LlmJsonRequest } from '../../ports/llm-one-shot.js';
import { query } from './sdk.js';

function buildOptions(req: LlmTextRequest): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    model: req.model,
    executable: 'node',
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    },
    maxTurns: req.maxTurns ?? 2,
  };
  if (req.systemPrompt !== undefined) opts.systemPrompt = req.systemPrompt;
  if (req.allowedTools !== undefined) {
    opts.allowedTools = req.allowedTools;
  } else {
    opts.tools = [];
  }
  if (req.cwd !== undefined) opts.cwd = req.cwd;
  if (req.stderr !== undefined) opts.stderr = req.stderr;
  return opts;
}

export class ClaudeLlmOneShot implements LlmOneShot {
  readonly kind = 'claude' as const;

  async text(req: LlmTextRequest): Promise<string | null> {
    let responseText = '';
    for await (const event of query({ prompt: req.prompt, options: buildOptions(req) as any })) {
      const type = (event as any).type;
      if (type === 'assistant') {
        const content = (event as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              responseText += block.text;
            }
          }
        }
      } else if (type === 'result') {
        if ((event as any).subtype === 'success') {
          const r = (event as any).result;
          if (typeof r === 'string' && r.trim()) {
            responseText = r;
          }
        }
      }
    }
    return responseText.trim() ? responseText : null;
  }

  async json(req: LlmJsonRequest): Promise<unknown | null> {
    const options = buildOptions(req) as any;
    options.outputFormat = { type: 'json_schema', schema: req.jsonSchema };
    for await (const event of query({ prompt: req.prompt, options })) {
      if ((event as any).type !== 'result') continue;
      if ((event as any).subtype === 'success') {
        return (event as any).structured_output ?? null;
      }
      return null;
    }
    return null;
  }
}

export const claudeLlmOneShot = new ClaudeLlmOneShot();
