/**
 * The board's drag, the pure part (no DOM, no React): where a card lands among a column's cards,
 * which column the pointer is over, how much the lifted card leans with its speed, and how fast
 * the board scrolls near an edge.
 */

export interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** A card's place top to bottom (screen or layout coordinates). */
export interface Span {
  readonly top: number;
  readonly bottom: number;
}

/** Where a card dropped at `y` goes among the column's other cards (their boxes, top to bottom). */
export function landingIndex(y: number, cards: readonly Span[]): number {
  const i = cards.findIndex((c) => y < c.top + (c.bottom - c.top) / 2);
  return i < 0 ? cards.length : i;
}

/** The column under `x` (or the nearest one: dragging past the last column still lands there). */
export function columnAt<T>(x: number, columns: ReadonlyArray<{ readonly key: T; readonly box: Box }>): T | undefined {
  if (!columns.length) return undefined;
  const inside = columns.find((c) => x >= c.box.left && x <= c.box.right);
  if (inside) return inside.key;
  return [...columns].sort((a, b) => distance(x, a.box) - distance(x, b.box))[0]!.key;
}

const distance = (x: number, b: Box): number => (x < b.left ? b.left - x : x > b.right ? x - b.right : 0);

/** How far the lifted card leans (degrees) for its sideways speed (px/s): a gentle sway, never more than `max`. */
export function leanFor(velocityX: number, max = 6): number {
  const deg = velocityX / 160;
  return Math.max(-max, Math.min(max, deg));
}

/** Scroll speed (px a frame) near an edge: 0 outside the `zone`, faster the closer to the edge. */
export function edgeSpeed(pos: number, start: number, end: number, zone = 56, max = 18): number {
  if (pos < start + zone) return -Math.ceil(max * Math.min(1, (start + zone - pos) / zone));
  if (pos > end - zone) return Math.ceil(max * Math.min(1, (pos - (end - zone)) / zone));
  return 0;
}

/** The pointer moved far enough from where it went down to be a drag (not a click). */
export const isDrag = (dx: number, dy: number, threshold = 4): boolean => Math.hypot(dx, dy) >= threshold;

/** A column's cards with one lifted out and, while it hovers there, a gap where it would land. */
export function withGap<T extends { readonly id: string }>(cards: readonly T[], lifted: string | undefined, gap: number | undefined): Array<T | 'gap'> {
  const rest: Array<T | 'gap'> = cards.filter((c) => c.id !== lifted);
  if (gap !== undefined) rest.splice(Math.max(0, Math.min(gap, rest.length)), 0, 'gap');
  return rest;
}

/** The neighbours a card dropped at `index` sits between (in the column without it). */
export function neighbours<T extends { readonly id: string }>(cards: readonly T[], lifted: string, index: number): { readonly before?: string; readonly after?: string } {
  const rest = cards.filter((c) => c.id !== lifted);
  const before = rest[index - 1];
  const after = rest[index];
  return { ...(before ? { before: before.id } : {}), ...(after ? { after: after.id } : {}) };
}

/** A card's slot in its column's layout: how far down the column's content it sits, and how tall it is. */
export interface Slot {
  readonly id: string;
  readonly top: number;
  readonly height: number;
}

/** A column's slots with `lifted` taken out: the ones below it move up into its room (its height and the `gap` between cards). */
export function closeUp(slots: readonly Slot[], lifted: string, gap: number): Span[] {
  const out = slots.find((s) => s.id === lifted);
  const shift = out ? out.height + gap : 0;
  return slots
    .filter((s) => s.id !== lifted)
    .map((s) => {
      const top = out && s.top > out.top ? s.top - shift : s.top;
      return { top, bottom: top + s.height };
    });
}

/**
 * The columns a scope hides, to open while a card is held: the ones before the first it shows
 * (they open on the left) and the rest (on the right), each in the board's order.
 */
export function foldedAround<K>(all: readonly K[], shown: readonly K[]): { readonly before: K[]; readonly after: K[] } {
  const first = all.findIndex((k) => shown.includes(k));
  const hidden = all.filter((k) => !shown.includes(k));
  if (first < 0) return { before: [], after: hidden };
  return { before: hidden.filter((k) => all.indexOf(k) < first), after: hidden.filter((k) => all.indexOf(k) > first) };
}

/** A column's box cut to what's visible of it (a column still opening is partly hidden); undefined when none is. */
export function clipBox(box: Box, clip: { readonly left: number; readonly right: number } | undefined): Box | undefined {
  if (!clip) return box;
  const left = Math.max(box.left, clip.left);
  const right = Math.min(box.right, clip.right);
  return right - left >= 1 ? { ...box, left, right } : undefined;
}

/** The board as measured once when a drag starts (and again when it scrolls): what spotIn needs, so a pointer move only does arithmetic. */
export interface ColumnGeometry<K> {
  readonly key: K;
  /** The column on screen. */
  readonly box: Box;
  /** Where its content starts on screen (the stack's top, less how far it's scrolled). */
  readonly origin: number;
  /** Its cards in content coordinates, the lifted one taken out. */
  readonly cards: readonly Span[];
}

/** Where a pointer at (x, y) would drop the card: the column under it, and the place among its cards. */
export function spotIn<K>(x: number, y: number, columns: readonly ColumnGeometry<K>[]): { readonly key: K; readonly index: number } | undefined {
  const key = columnAt(x, columns);
  const col = key === undefined ? undefined : columns.find((c) => c.key === key);
  return col ? { key: col.key, index: landingIndex(y - col.origin, col.cards) } : undefined;
}
