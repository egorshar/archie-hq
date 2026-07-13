/**
 * Render GitHub-flavored markdown to ANSI for the Ink TUI.
 *
 * Agents emit markdown (headings, bold, lists, fenced code, links). Without
 * this the TUI shows the raw `#`, `**`, backticks, etc., which is hard to read.
 * marked + marked-terminal convert it to ANSI, which Ink's <Text> renders as-is.
 * Falls back to the raw text on any parse error so a message is never lost.
 */
import { Marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';

// One configured instance per wrap width (marked-terminal reflows to `width`).
const cache = new Map<number, Marked>();

function instanceFor(width: number): Marked {
  let m = cache.get(width);
  if (!m) {
    // @types/marked-terminal (v6) types the return as TerminalRenderer; the
    // runtime (v7) returns a marked extension. Cast to the shape marked expects.
    m = new Marked(
      // showSectionPrefix defaults to true, which re-prepends a literal `#`
      // (repeated per heading level) to headings — disable it so headings
      // render as plain styled text instead of raw markdown syntax.
      markedTerminal({ width, reflowText: true, showSectionPrefix: false }) as unknown as MarkedExtension,
    );
    cache.set(width, m);
  }
  return m;
}

export function renderMarkdown(text: string, width = 80): string {
  try {
    const w = Math.max(20, Math.floor(width));
    const out = instanceFor(w).parse(text, { async: false }) as string;
    // marked-terminal pads with surrounding blank lines; trim them so the block
    // sits flush in the log stream.
    const trimmed = out.replace(/^\n+/, '').replace(/\n+$/, '');
    // marked-terminal renders unordered-list items with a `*` bullet; rewrite
    // to `•` for readability. Match the bullet at line start, tolerating ANSI
    // color codes and leading indentation that marked-terminal may emit.
    // eslint-disable-next-line no-control-regex
    return trimmed.replace(/^(\s*(?:\[[0-9;]*m)*)\*(\s)/gm, '$1•$2');
  } catch {
    return text;
  }
}
