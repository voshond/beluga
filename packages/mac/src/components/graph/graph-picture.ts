import { toBlob } from 'html-to-image';

/**
 * A graph as a PNG (Copy as Image, Save as Image…): its whole drawing at 1:1 with the dotted
 * background around it, drawn in this window, so the picture is made on the computer you sit at.
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
    backgroundColor: getComputedStyle(host).backgroundColor,
    // The frame is hidden behind the window: in the picture it shows, at its corner.
    style: { position: 'relative', left: '0', top: '0', opacity: '1' },
    filter: (node) => !(node instanceof Element && leftOut.some((c) => node.classList.contains(c))),
  });
  if (!blob) throw new Error('The web view drew nothing');
  return blob;
}
