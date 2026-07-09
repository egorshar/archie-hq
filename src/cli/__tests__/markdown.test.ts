import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.js';

// Colour output depends on TTY/chalk; under vitest it's typically disabled, so
// these assert the structural transform (syntax stripped, content kept) which
// holds regardless of colour.
describe('renderMarkdown', () => {
  it('strips bold markers but keeps the text', () => {
    const out = renderMarkdown('**bold**');
    expect(out).toContain('bold');
    expect(out).not.toContain('**');
  });

  it('renders inline code without backticks', () => {
    const out = renderMarkdown('`code`');
    expect(out).toContain('code');
    expect(out).not.toContain('`');
  });

  it('keeps heading text', () => {
    expect(renderMarkdown('# Title')).toContain('Title');
  });

  it('renders list items', () => {
    const out = renderMarkdown('- alpha\n- beta');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('passes plain prose through', () => {
    expect(renderMarkdown('hello world')).toContain('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('does not throw on malformed markdown', () => {
    expect(() => renderMarkdown('```\nunterminated fence')).not.toThrow();
  });
});
