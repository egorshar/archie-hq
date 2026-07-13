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

// The slice of the marked-terminal extension shape we patch below; the full
// extension has many more renderer hooks (code, heading, table, ...) we
// don't need to touch.
type ListRenderable = {
  renderer: { list: (this: unknown, ...args: unknown[]) => unknown };
};

// One configured instance per wrap width (marked-terminal reflows to `width`).
const cache = new Map<number, Marked>();

function instanceFor(width: number): Marked {
  let m = cache.get(width);
  if (!m) {
    // @types/marked-terminal (v6) types the return as TerminalRenderer; the
    // runtime (v7) returns a marked extension. Cast to the shape marked expects.
    const rawExtension = markedTerminal({
      width,
      reflowText: true,
      // showSectionPrefix defaults to true, which re-prepends a literal `#`
      // (repeated per heading level) to headings — disable it so headings
      // render as plain styled text instead of raw markdown syntax.
      showSectionPrefix: false,
    });
    const extension = rawExtension as unknown as ListRenderable;

    // marked-terminal renders unordered-list items with a literal `*`
    // bullet (hardcoded in its Renderer, not exposed via options). We used
    // to rewrite `*` to `•` with a regex over the FULL rendered output, but
    // that also matched line-start `*` inside fenced code blocks (e.g. a
    // JSDoc `* @param` comment), corrupting code shown in the TUI. Instead,
    // wrap the `list` renderer hook, which only ever runs on a single list
    // token's own body — fenced code is rendered by a separate `code` hook
    // that this never touches — and swap the bullet there.
    const renderList = extension.renderer.list;
    extension.renderer.list = function (...args: unknown[]) {
      const rendered = renderList.apply(this, args);
      return typeof rendered === 'string' ? rendered.replace(/^(\s*)\* /gm, '$1• ') : rendered;
    };

    m = new Marked(rawExtension as unknown as MarkedExtension);
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
    return out.replace(/^\n+/, '').replace(/\n+$/, '');
  } catch {
    return text;
  }
}
