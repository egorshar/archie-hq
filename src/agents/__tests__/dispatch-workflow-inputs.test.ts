/**
 * Regression: `dispatch_workflow`'s `inputs` must survive as a flat string→string
 * map even when a caller delivers it as a JSON STRING.
 *
 * A tool transport that types the `z.record` loosely (as a free-form object) can
 * let a model fill it with a *stringified* object. The handler used to pass that
 * straight to the GitLab client, where `Object.entries("{...}")` yields
 * per-character garbage variables — so US_BOT / REVIEW_*_BRANCH never reached
 * GitLab and the pipeline was rejected with `400 workflow:rules` (observed on
 * FPP-516; the agent worked around it by curling the API by hand).
 * `normalizeWorkflowInputs` accepts either shape.
 */
import { describe, it, expect } from 'vitest';
import { normalizeWorkflowInputs } from '../tools.js';

describe('normalizeWorkflowInputs (dispatch_workflow inputs)', () => {
  it('passes a plain object through, coercing values to strings', () => {
    expect(normalizeWorkflowInputs({ US_BOT: 'true', PAGE: 5 })).toEqual({ US_BOT: 'true', PAGE: '5' });
  });

  it('parses a JSON-string object (the loosely-typed-transport case)', () => {
    expect(
      normalizeWorkflowInputs('{"US_BOT":"true","REVIEW_SERVER_BRANCH":"feature/FPP-516"}'),
    ).toEqual({ US_BOT: 'true', REVIEW_SERVER_BRANCH: 'feature/FPP-516' });
  });

  it('returns undefined for nullish / empty', () => {
    expect(normalizeWorkflowInputs(undefined)).toBeUndefined();
    expect(normalizeWorkflowInputs(null)).toBeUndefined();
    expect(normalizeWorkflowInputs('')).toBeUndefined();
    expect(normalizeWorkflowInputs('   ')).toBeUndefined();
    expect(normalizeWorkflowInputs({})).toBeUndefined();
  });

  it('rejects a JSON string that is not an object (array / scalar)', () => {
    expect(() => normalizeWorkflowInputs('["US_BOT"]')).toThrow(/flat object/);
    expect(() => normalizeWorkflowInputs('"US_BOT=true"')).toThrow(/flat object/);
  });

  it('rejects an unparseable string', () => {
    expect(() => normalizeWorkflowInputs('US_BOT=true')).toThrow(/unparseable|JSON object/);
  });
});
