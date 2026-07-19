import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.js';

// marked-terminal emits ANSI colour codes when chalk detects colour support,
// which varies by environment (TTY / FORCE_COLOR). These tests assert the
// structural transform (markdown syntax stripped, content kept, no `•`
// corruption), so strip ANSI first — the transform holds regardless of colour.
// (Build the ESC matcher from a char code to avoid a raw control byte here.)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');
const md = (text: string, width = 80): string => stripAnsi(renderMarkdown(text, width));

describe('renderMarkdown', () => {
  it('strips bold markers but keeps the text', () => {
    const out = md('**bold**');
    expect(out).toContain('bold');
    expect(out).not.toContain('**');
  });

  it('renders inline code without backticks', () => {
    const out = md('`code`');
    expect(out).toContain('code');
    expect(out).not.toContain('`');
  });

  it('keeps heading text', () => {
    expect(md('# Title')).toContain('Title');
  });

  it('renders list items', () => {
    const out = md('- alpha\n- beta');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('passes plain prose through', () => {
    expect(md('hello world')).toContain('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(md('')).toBe('');
  });

  it('does not throw on malformed markdown', () => {
    expect(() => renderMarkdown('```\nunterminated fence')).not.toThrow();
  });
});

describe('renderMarkdown lists & structure', () => {
  it('renders unordered-list items', () => {
    const out = md('- alpha\n- beta', 80);
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('renders a heading without the leading #', () => {
    const out = md('# Title here', 80);
    expect(out).toContain('Title here');
    expect(out).not.toContain('# Title here');
  });

  it('preserves fenced code content', () => {
    const out = md('```\nconst x = 1;\n```', 80);
    expect(out).toContain('const x = 1;');
  });

  it('does not corrupt a JSDoc-style `*` line inside fenced code', () => {
    const out = md('```\n/**\n * @param x - the value\n */\n```', 80);
    expect(out).toContain('* @param');
    expect(out).not.toContain('• @param');
  });

  it('returns plain text unchanged (trimmed)', () => {
    expect(md('just words', 80)).toBe('just words');
  });
});
