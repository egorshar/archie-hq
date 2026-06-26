/**
 * Unit tests for modelDisplayLabel — resolving SDK model strings to footer
 * labels, preserving the `[1m]` 1M-context marker.
 */

import { describe, it, expect } from 'vitest';
import { modelDisplayLabel } from '../model-label.js';

describe('modelDisplayLabel', () => {
  it('maps short aliases to full display ids', () => {
    expect(modelDisplayLabel('opus')).toBe('claude-opus-4-8');
    expect(modelDisplayLabel('sonnet')).toBe('claude-sonnet-4-6');
    expect(modelDisplayLabel('haiku')).toBe('claude-haiku-4-5');
  });

  it('preserves the [1m] suffix and re-attaches it after mapping', () => {
    expect(modelDisplayLabel('sonnet[1m]')).toBe('claude-sonnet-4-6[1m]');
    expect(modelDisplayLabel('opus[1m]')).toBe('claude-opus-4-8[1m]');
  });

  it('passes already-full or unknown ids through unchanged', () => {
    expect(modelDisplayLabel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(modelDisplayLabel('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6[1m]');
    expect(modelDisplayLabel('some-future-model')).toBe('some-future-model');
  });

  it('is case-insensitive on the [1m] marker and tolerates whitespace', () => {
    expect(modelDisplayLabel('sonnet[1M]')).toBe('claude-sonnet-4-6[1m]');
    expect(modelDisplayLabel('  opus  ')).toBe('claude-opus-4-8');
  });
});
