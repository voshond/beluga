import { type RefObject, useEffect, useRef, useState } from 'react';
import { isShortcut } from '../lib/shortcuts.js';

/**
 * Going back the Mac way (BLG-5): a two-finger swipe to the right on the trackpad (as in Safari
 * and Chrome: horizontal wheel events, deltaX < 0), ⌘[ and Esc. The swipe is a small model
 * (swipeStep, tested on its own) that the hook feeds wheel events to; while it builds up, an
 * arrow comes in from the left edge, and letting go past the threshold goes back.
 */

/** How far (in pixels of scrolling) a swipe goes before letting go goes back. */
export const SWIPE_THRESHOLD = 120;
/** A pause this long between wheel events ends the gesture. */
export const SWIPE_END_MS = 140;

export interface Swipe {
  /** The gesture's direction, once its first events said: sideways (it may go back) or not. */
  readonly axis?: 'x' | 'y';
  /** How far it went to the right, 0 to 1 (1: letting go goes back). */
  readonly progress: number;
}

export const NO_SWIPE: Swipe = { progress: 0 };

/** One wheel event (in pixels) into the gesture. */
export function swipeStep(swipe: Swipe, deltaX: number, deltaY: number): Swipe {
  // The gesture's first real move decides: mostly sideways, or a scroll (then it's never a swipe).
  const axis = swipe.axis ?? (Math.abs(deltaX) + Math.abs(deltaY) < 2 ? undefined : Math.abs(deltaX) > Math.abs(deltaY) * 1.5 ? 'x' : 'y');
  if (axis !== 'x') return axis === swipe.axis ? swipe : { ...swipe, ...(axis ? { axis } : {}) };
  // Fingers to the right scroll content left: deltaX < 0. Back to the left undoes it.
  const progress = Math.min(1, Math.max(0, swipe.progress + -deltaX / SWIPE_THRESHOLD));
  return { axis, progress };
}

/** The wheel event's move in pixels (lines and pages are rare on a Mac, but count them too). */
const pixels = (e: WheelEvent, d: number): number => (e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * 400 : d);

/** Whether something under the pointer would scroll left itself (a wide table, a code block). */
function scrollsLeft(target: EventTarget | null, root: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && el.scrollLeft > 0) {
      const o = getComputedStyle(el).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
  }
  return false;
}

/** Typing somewhere, or a menu or dialog open: Esc and ⌘[ are theirs. */
function busyElsewhere(e: KeyboardEvent): boolean {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t && (t.isContentEditable || t.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))) return true;
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'));
}

/** Pages showing with a Back of their own (to their list). */
let ownBacks = 0;

/** A page with its own Back is showing: ⌘[ is that Back's, not the window's (lib/nav.ts). */
export const pageHasOwnBack = (): boolean => ownBacks > 0;

/**
 * Go back with a two-finger swipe right over `area`, ⌘[ or Esc. → how far a swipe is (0 to 1),
 * for the edge's arrow (SwipeBackEdge).
 */
export function useSwipeBack(area: RefObject<HTMLElement | null>, back: () => void): number {
  const [progress, setProgress] = useState(0);
  const go = useRef(back);
  go.current = back;
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    // Counted only once its ⌘[ is listened for (below), so ⌘[ is never left to nobody.
    ownBacks += 1;
    let swipe = NO_SWIPE;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const show = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setProgress(swipe.progress);
      });
    };
    const end = (): void => {
      timer = undefined;
      const done = swipe.axis === 'x' && swipe.progress >= 1;
      swipe = NO_SWIPE;
      show();
      if (done) go.current();
    };
    const onWheel = (e: WheelEvent): void => {
      // Pinch-zoom (ctrlKey) and anything that scrolls sideways itself aren't a swipe back.
      if (e.ctrlKey || (swipe === NO_SWIPE && scrollsLeft(e.target, el))) return;
      swipe = swipeStep(swipe, pixels(e, e.deltaX), pixels(e, e.deltaY));
      if (timer) clearTimeout(timer);
      timer = setTimeout(end, SWIPE_END_MS);
      if (swipe.axis === 'x') show();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const cmdBracket = isShortcut('page-back', e);
      const esc = e.key === 'Escape' && !e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey;
      if (!cmdBracket && !esc) return;
      // ⌘[ (your Back, Settings › Keyboard) goes back even from a field, as in Safari; Esc leaves fields and menus to themselves.
      if (esc && busyElsewhere(e)) return;
      if (cmdBracket && document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      go.current();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      ownBacks -= 1;
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      if (timer) clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [area]);
  return progress;
}
