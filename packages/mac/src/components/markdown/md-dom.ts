import { anchorIds } from './md-paths.js';
import { reducedMotion } from './use-doc-theme.js';

/** Marks the element a document scrolls in (the focus view's page, the panel's preview). */
export const SCROLL_ROOT = 'data-reader-scroll';

/** The element that scrolls `el`: the page it's read in, else the nearest one that scrolls. */
export function scrollParent(el: HTMLElement): HTMLElement | undefined {
  const marked = el.closest<HTMLElement>(`[${SCROLL_ROOT}]`);
  if (marked) return marked;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return undefined;
}

/**
 * Bring `el` to the top of the page that scrolls it (a little below the edge). Only that page
 * moves: scrollIntoView would also nudge the window's own clipped containers.
 */
export function scrollToElement(el: HTMLElement, opts: { smooth?: boolean; offset?: number } = {}): void {
  const root = scrollParent(el);
  if (!root) return;
  const top = root.scrollTop + el.getBoundingClientRect().top - root.getBoundingClientRect().top - (opts.offset ?? 16);
  root.scrollTo({ top: Math.max(0, top), behavior: opts.smooth && !reducedMotion() ? 'smooth' : 'auto' });
}

/** The heading or footnote a `#hash` names in this document, if it has one. */
export function findAnchor(article: HTMLElement, hash: string): HTMLElement | undefined {
  for (const id of anchorIds(hash)) {
    const el = article.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (el) return el;
  }
  return undefined;
}

/** Text Find shouldn't look in: drawn diagrams, KaTeX's hidden MathML, decorations, the outline. */
const SKIP = 'svg, .katex-mathml, [aria-hidden="true"], button, nav';

/**
 * Every place `query` appears in the text under `root` (case-insensitive), also across the
 * pieces a line is drawn in (a colored token, a bold word).
 */
export function rangesIn(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    nodes.push(n as Text);
    starts.push(all.length);
    all += (n.nodeValue ?? '').toLowerCase();
  }
  // The text node a position in `all` falls in (binary search over where each starts).
  const locate = (pos: number, end: boolean): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! < pos || (!end && starts[mid] === pos)) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo]!, pos - starts[lo]!];
  };
  const out: Range[] = [];
  for (let at = all.indexOf(q); at >= 0; at = all.indexOf(q, at + q.length)) {
    const r = document.createRange();
    r.setStart(...locate(at, false));
    r.setEnd(...locate(at + q.length, true));
    out.push(r);
  }
  return out;
}
