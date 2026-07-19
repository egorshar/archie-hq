/**
 * Bridge arg-schema fidelity. The bridge's `/tools` manifest must convey NESTED
 * arg shapes (arrays-of-objects, object properties) + field descriptions, not
 * flatten everything to a bare kind. Regression for the 2026-07-10 "no MR" bug:
 * `spawn_repo_agent`'s `repos: [{github, baseBranch}]` was flattened to a plain
 * `object`, so the generated plugin advertised it as `tool.schema.any()`, the
 * opencode model constructed it wrong, and `args.repos[0].github` arrived
 * undefined -> `GET /projects/undefined -> 404` -> spawn failed -> no repo agent.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodFieldToArgSpec } from '../server.js';

describe('zodFieldToArgSpec — nested fidelity', () => {
  it('serializes an array-of-objects with per-field types, optionality, and descriptions', () => {
    const field = z
      .array(
        z.object({
          github: z.string().describe('Github identifier, e.g. "org/repo"'),
          baseBranch: z.string().optional(),
        }),
      )
      .describe('Repos this agent will work with.');
    const spec = zodFieldToArgSpec(field);
    expect(spec.type).toBe('array');
    expect(spec.description).toBe('Repos this agent will work with.');
    expect(spec.items?.type).toBe('object');
    expect(spec.items?.properties?.github).toEqual({
      type: 'string',
      description: 'Github identifier, e.g. "org/repo"',
    });
    expect(spec.items?.properties?.baseBranch).toEqual({ type: 'string', optional: true });
  });

  it('keeps primitives flat (backward compatible with the old shape)', () => {
    expect(zodFieldToArgSpec(z.string())).toEqual({ type: 'string' });
    expect(zodFieldToArgSpec(z.string().optional())).toEqual({ type: 'string', optional: true });
    expect(zodFieldToArgSpec(z.number())).toEqual({ type: 'number' });
    expect(zodFieldToArgSpec(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('serializes enums as a string with allowed values', () => {
    expect(zodFieldToArgSpec(z.enum(['fast', 'slow']))).toEqual({ type: 'string', enum: ['fast', 'slow'] });
  });

  it('serializes a plain object with typed properties', () => {
    const spec = zodFieldToArgSpec(z.object({ id: z.number(), name: z.string().optional() }));
    expect(spec.type).toBe('object');
    expect(spec.properties?.id).toEqual({ type: 'number' });
    expect(spec.properties?.name).toEqual({ type: 'string', optional: true });
  });
});
