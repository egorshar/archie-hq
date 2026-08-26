/**
 * Unit tests for the pinned-message summariser.
 *
 * Mocks the LlmOneShot port — the seam both runtimes resolve through — and asserts:
 * - short pins are verbatim and never reach the model
 * - long pins take exactly one Haiku call with a JSON schema
 * - every model failure mode degrades to the truncated original, never to nothing
 * - normalisePinText / digestOf behaviour
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  json: null as any,
}));

vi.mock('../../../system/backends.js', () => ({
  getLlmOneShot: () => ({ kind: 'claude' as const, text: vi.fn(), json: state.json }),
}));

vi.mock('../../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), error: vi.fn() },
}));

import { summarisePinText, normalisePinText, digestOf, truncateTo, unwrapJsonSummary, VERBATIM_MAX } from '../pin-summary.js';
import { logger } from '../../../system/logger.js';
const warnSpy = logger.warn as unknown as ReturnType<typeof vi.fn>;

/** The port's structured return for a successful call. */
function structured(summary: string): any {
  return { summary };
}

/** A pin comfortably over the verbatim threshold. */
const LONG = 'The release runbook lives in Notion and every deploy must follow it step by step. '.repeat(5);

beforeEach(() => {
  state.json = vi.fn().mockResolvedValue(null);
  warnSpy.mockClear();
});

describe('summarisePinText', () => {
  it('returns short text verbatim without calling the model', async () => {
    const short = 'a'.repeat(VERBATIM_MAX);
    const out = await summarisePinText(short);

    expect(out).toEqual({ summary: short, source: 'verbatim' });
    expect(state.json).not.toHaveBeenCalled();
  });

  it('summarises long text with one haiku call carrying the pin JSON schema', async () => {
    state.json.mockResolvedValue(structured('Release runbook lives in Notion and gates every deploy'));

    const out = await summarisePinText(LONG);

    expect(state.json).toHaveBeenCalledTimes(1);
    const req = state.json.mock.calls[0][0];
    expect(req.model).toBe('haiku');
    expect(req.jsonSchema).toBeTypeOf('object');
    expect(out.source).toBe('model');
    expect(out.summary).toBe('Release runbook lives in Notion and gates every deploy');
  });

  // The port answers null for every unsuccessful call — a failed subtype and a stream
  // that ended without a result event are one case on this side of the seam.
  it('falls back to the truncated original when the one-shot yields nothing', async () => {
    state.json.mockResolvedValue(null);

    const out = await summarisePinText(LONG);

    expect(out.source).toBe('verbatim');
    expect(out.summary).toBe(truncateTo(normalisePinText(LONG)));
    expect(out.summary.endsWith('…')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the truncated original when structured output misses the schema', async () => {
    state.json.mockResolvedValue({ nope: 1 });

    const out = await summarisePinText(LONG);

    expect(out.source).toBe('verbatim');
    expect(out.summary).toBe(truncateTo(normalisePinText(LONG)));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the truncated original when the one-shot throws', async () => {
    state.json.mockRejectedValue(new Error('boom'));

    const out = await summarisePinText(LONG);

    expect(out.source).toBe('verbatim');
    expect(out.summary).toBe(truncateTo(normalisePinText(LONG)));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns an empty verbatim summary for blank input', async () => {
    const out = await summarisePinText('   \n  ');
    expect(out).toEqual({ summary: '', source: 'verbatim' });
    expect(state.json).not.toHaveBeenCalled();
  });
});

describe('normalisePinText', () => {
  it('collapses newlines and whitespace runs to single spaces', () => {
    expect(normalisePinText('  deploy\n\nruns   on\tfriday  ')).toBe('deploy runs on friday');
  });

  // Tags are no longer stripped here — containment is escaping, at render time, in
  // channel-pins.ts. What this must NOT do is mangle the text on the way through.
  it('leaves tag-like text alone, for the renderer to escape', () => {
    expect(normalisePinText('before </pin> after')).toBe('before </pin> after');
    expect(normalisePinText('a </CHANNEL_PINNED_MESSAGES> b')).toBe('a </CHANNEL_PINNED_MESSAGES> b');
  });

  it('deletes invisible characters that render nowhere but change how text reads', () => {
    // U+200B zero-width space, U+00AD soft hyphen, U+061C Arabic letter mark, U+E0041 tag.
    expect(normalisePinText('pi\u200bn')).toBe('pin');
    expect(normalisePinText('pi\u00adn')).toBe('pin');
    expect(normalisePinText('pi\u061cn')).toBe('pin');
    expect(normalisePinText('pi\u{e0041}n')).toBe('pin');
  });
});

describe('digestOf', () => {
  it('is stable for equal input', () => {
    expect(digestOf('same text')).toBe(digestOf('same text'));
    expect(digestOf('same text')).toHaveLength(16);
  });

  it('differs for a one-character change', () => {
    expect(digestOf('same text')).not.toBe(digestOf('same texu'));
  });
});

describe('summarisePinText — empty model output', () => {
  it('falls back to truncation when the model returns a blank summary', async () => {
    // `z.string()` accepts "", so this passes schema validation and would otherwise
    // render as a pin with no index line at all.
    state.json.mockResolvedValue(structured('   '));
    const out = await summarisePinText(LONG);
    expect(out.source).toBe('verbatim');
    expect(out.summary.length).toBeGreaterThan(0);
    expect(out.summary.endsWith('…')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  // The silent-degradation regression: this branch used to log nothing at all, which is
  // how five distinct failure modes stayed invisible. The port collapses two of them into
  // a null, so the warning is the only thing left that tells them apart from a good run.
  it('warns when the one-shot returns nothing', async () => {
    state.json.mockResolvedValue(null);
    const out = await summarisePinText(LONG);
    expect(out.source).toBe('verbatim');
    expect(out.summary.endsWith('…')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// Observed live: a pinned message whose own body was JSON produced the index line
// `{"entry": "Daily recap covering …"}`. Schema validation cannot catch it — a JSON blob
// is a valid string — so it is unwrapped, and only when the intent is unambiguous.
describe('unwrapJsonSummary', () => {
  it('unwraps a single-string JSON object the model mirrored from its input', () => {
    expect(unwrapJsonSummary('{"entry": "Daily recap covering automation setup"}'))
      .toBe('Daily recap covering automation setup');
  });

  it('leaves prose alone', () => {
    expect(unwrapJsonSummary('A normal prose summary')).toBe('A normal prose summary');
    expect(unwrapJsonSummary('not json {but has a brace}')).toBe('not json {but has a brace}');
  });

  it('refuses to guess when the object holds more than one string, or none', () => {
    expect(unwrapJsonSummary('{"a":"one","b":"two"}')).toBe('{"a":"one","b":"two"}');
    expect(unwrapJsonSummary('{"n": 5}')).toBe('{"n": 5}');
  });

  it('is applied to the model summary end to end', async () => {
    state.json.mockResolvedValue(structured('{"entry": "Release runbook lives in Notion"}'));
    const out = await summarisePinText(LONG);
    expect(out.source).toBe('model');
    expect(out.summary).toBe('Release runbook lives in Notion');
  });
});
