/**
 * A live preview Claude shows in chat (Settings › Experimental › Live previews), as a fenced block:
 *
 *   ```beluga-preview
 *   src/components/PriceCard.tsx
 *   export: PriceCard
 *   props: {"plan": "Pro", "price": 24}
 *   ```
 *
 * The first line is what to draw: a component file in the worktree, an .html file there, or a
 * page on this computer's own dev server (http://localhost:5173/pricing). The rest is optional:
 * which export, props to start from (the others are filled in from the component's types), a CSS
 * file the app's styles live in, a width to show a page at, and a line about it. Browser-safe.
 */

export const PREVIEW_FENCE = 'beluga-preview';

export const PREVIEW_SIZES = ['phone', 'tablet', 'desktop'] as const;
export type PreviewSize = (typeof PREVIEW_SIZES)[number];

/** How wide each size draws a page (CSS pixels), scaled down to fit the chat. */
export const SIZE_WIDTH: Readonly<Record<PreviewSize, number>> = { phone: 390, tablet: 820, desktop: 1280 };

export type PreviewTarget =
  | { readonly kind: 'component'; readonly file: string; readonly export?: string }
  | { readonly kind: 'html'; readonly file: string }
  | { readonly kind: 'url'; readonly url: string };

export interface PreviewRef {
  readonly target: PreviewTarget;
  /** Props Claude chose (JSON); the rest come from the types. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** A stylesheet in the worktree the component needs (the app's global CSS). */
  readonly css?: string;
  /** A wrapper in the worktree giving it its providers (else the project's preview-wrapper file). */
  readonly wrap?: string;
  readonly size?: PreviewSize;
  readonly note?: string;
}

/** Files that can be drawn as a component. */
export const COMPONENT_FILE = /\.(tsx|jsx|ts|js|mjs|vue|svelte)$/i;
export const HTML_FILE = /\.html?$/i;

/** Only pages on this computer: a preview never frames the open web into the chat. */
export function loopbackUrl(text: string): string | undefined {
  try {
    const url = new URL(text.trim());
    // Exactly what the window may frame (tauri.conf.json frame-src): anything else would draw blank.
    if (url.protocol !== 'http:') return undefined;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** A worktree-relative path as written: no absolute paths, no way out of the worktree. */
function relativeFile(text: string): string | undefined {
  const file = text.trim().replace(/^`|`$/g, '').replace(/^\.\//, '');
  if (!file || file.startsWith('/') || file.startsWith('~') || /^[a-z]:[\\/]/i.test(file)) return undefined;
  if (file.split(/[\\/]/).includes('..')) return undefined;
  return /^[^\s]+$/.test(file) ? file : undefined;
}

function targetOf(first: string): PreviewTarget | undefined {
  const line = first.replace(/^(url|file|page)\s*:\s*/i, '');
  if (/^https?:\/\//i.test(line)) {
    const url = loopbackUrl(line);
    return url ? { kind: 'url', url } : undefined;
  }
  const file = relativeFile(line);
  if (!file) return undefined;
  if (HTML_FILE.test(file)) return { kind: 'html', file };
  if (COMPONENT_FILE.test(file)) return { kind: 'component', file };
  return undefined;
}

function propsOf(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A beluga-preview fence's text → what to draw (undefined when its first line isn't something it can). */
export function parsePreviewRef(code: string): PreviewRef | undefined {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  const target = lines[0] ? targetOf(lines[0]) : undefined;
  if (!target) return undefined;
  let exported: string | undefined;
  let props: Record<string, unknown> | undefined;
  let css: string | undefined;
  let wrap: string | undefined;
  let size: PreviewSize | undefined;
  let note: string | undefined;
  // props may run over several lines: the JSON is everything after "props:" up to the next key.
  const rest = lines.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const m = /^(export|props|css|wrap|size|note)\s*:\s*(.*)$/i.exec(rest[i]!);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let value = m[2]!.trim();
    if (key === 'props') {
      while (i + 1 < rest.length && !/^(export|css|wrap|size|note)\s*:/i.test(rest[i + 1]!)) value += `\n${rest[++i]!}`;
      props = propsOf(value);
    } else if (key === 'export' && /^[A-Za-z_$][\w$]*$/.test(value)) exported = value;
    else if (key === 'css') css = relativeFile(value);
    else if (key === 'wrap') wrap = relativeFile(value);
    else if (key === 'size') size = (PREVIEW_SIZES as readonly string[]).includes(value.toLowerCase()) ? (value.toLowerCase() as PreviewSize) : undefined;
    else if (key === 'note') note = value || undefined;
  }
  const withExport: PreviewTarget = target.kind === 'component' && exported ? { ...target, export: exported } : target;
  return { target: withExport, ...(props ? { props } : {}), ...(css ? { css } : {}), ...(wrap ? { wrap } : {}), ...(size ? { size } : {}), ...(note ? { note } : {}) };
}

/** Where a preview's newest picture is kept, under the worktree's scratch folder (the phone shows it). */
export const STILLS_DIR = 'previews';

/** A preview's picture's file name: one per file or page, the newest one kept. */
export function stillName(target: PreviewTarget): string {
  const what = target.kind === 'url' ? target.url.replace(/^https?:\/\//, '') : target.file;
  return `${what.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'preview'}.png`;
}

/** How the phone's words point at a preview's picture (companion/views.ts resolves it, or says it in words). */
export const STILL_SCHEME = 'beluga-still:';

/** What a preview is called on its header: the component, the file, or the page. */
export function previewTitle(ref: PreviewRef): string {
  const t = ref.target;
  if (t.kind === 'url') {
    const url = new URL(t.url);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  }
  const name = t.file.split('/').pop() ?? t.file;
  return t.kind === 'component' && t.export ? `${t.export} · ${name}` : name;
}
