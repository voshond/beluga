import { toBlob } from 'html-to-image';

/**
 * A graph as a PNG (Copy as Image, Save as Image…): its whole drawing at 1:1 on its dotted
 * background, the same room on every side and 12px round corners (see through, outside them),
 * drawn in this window, so the picture is made on the computer you sit at.
 */

/** Room around the drawing in the picture. */
export const PICTURE_PAD = 32;

/** Twice as sharp as on screen, unless that's more than a web view will draw. */
const MAX_SIDE = 12_000;
const MAX_PIXELS = 40_000_000;

export const pictureScale = (width: number, height: number): number => Math.max(0.25, Math.min(2, MAX_SIDE / Math.max(width, height, 1), Math.sqrt(MAX_PIXELS / Math.max(width * height, 1))));

/** A file name from the graph's title. */
export const pictureName = (title: string | undefined): string => `${(title ?? 'Graph').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Graph'}.png`;

const leftOut = ['react-flow__attribution', 'react-flow__panel', 'react-flow__minimap'];

const DRAWN = ['.react-flow__node', '.react-flow__edge-path', '.react-flow__edgelabel-renderer > *'].join(', ');

/** What's drawn on `canvas` (nodes, lines, their labels), in the drawing's own units (the view is at 1:1). */
export const drawnBox = (canvas: HTMLElement): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined => {
  const origin = canvas.querySelector('.react-flow__viewport')?.getBoundingClientRect();
  const rects = [...canvas.querySelectorAll(DRAWN)].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
  if (!origin || !rects.length) return undefined;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { x: Math.floor(left - origin.left), y: Math.floor(top - origin.top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
};

/** How an SVG part is painted. html-to-image copies an SVG without the styles its classes give its parts. */
const PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'display', 'visibility'];

/** Each SVG part's paint written on it (the frame is a throwaway copy of the graph). */
const inlinePaint = (host: HTMLElement): void => {
  for (const el of host.querySelectorAll<SVGElement>('svg *')) {
    const style = getComputedStyle(el);
    for (const name of PAINT) el.style.setProperty(name, style.getPropertyValue(name));
  }
};

/** The picture of `host`, the offscreen frame GraphPicture draws the graph in. */
export async function drawPicture(host: HTMLElement): Promise<Blob> {
  const { width, height } = host.getBoundingClientRect();
  inlinePaint(host);
  const blob = await toBlob(host, {
    width,
    height,
    pixelRatio: pictureScale(width, height),
    // The frame is hidden behind the window: in the picture it shows, at its corner.
    style: { position: 'relative', left: '0', top: '0', opacity: '1' },
    filter: (node) => !(node instanceof Element && leftOut.some((c) => node.classList.contains(c))),
  });
  if (!blob) throw new Error('The web view drew nothing');
  return blob;
}
