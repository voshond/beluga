/**
 * Files dragged from Finder onto a conversation, as plain data: whether the drag is over it (the
 * app reports where in physical pixels), and which of the dropped paths can go with a message.
 * No DOM here, so it's tested on its own (use-attachments.tsx does the rest).
 */

import { keyPlatform } from '../lib/shortcuts-model.js';

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The drag at `x`, `y` (as the app gives them, `scale` of them to a CSS pixel: see dropScale) is over `box` (CSS pixels). A box with no size (hidden) is never hit. */
export function dropHits(box: Box | undefined, x: number, y: number, scale = 1): boolean {
  if (!box || box.right <= box.left || box.bottom <= box.top) return false;
  const px = x / (scale || 1);
  const py = y / (scale || 1);
  return px >= box.left && px <= box.right && py >= box.top && py <= box.bottom;
}

/**
 * How many of the app's drop units make one CSS pixel. The app calls them physical pixels, but on
 * a Mac and on Linux they're points, the page's own pixels (BLG-1000); only Windows gives the
 * screen's. Dividing by a Retina Mac's 2 found the drop up and to the left of the pointer.
 */
export const dropScale = (os: string, dpr: number): number => (os === 'windows' ? dpr || 1 : 1);

/** dropScale for this window. */
export const appDropScale = (): number => dropScale(keyPlatform(), globalThis.devicePixelRatio || 1);

/** The same place on screen (so a drag moving over it doesn't draw it again). */
export const sameBox = (a: Box | undefined, b: Box | undefined): boolean => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);

/** How many dropped paths are looked at (Beluga checks up to this many at once). */
export const MAX_DROPPED = 20;

/** Of the dropped paths' details: the files (images and others, in order), and how many weren't files (folders, gone). */
export function droppedFiles<T extends { readonly kind: string }>(infos: readonly T[]): { readonly files: T[]; readonly skipped: number } {
  const files = infos.filter((f) => f.kind === 'file');
  return { files, skipped: infos.length - files.length };
}
