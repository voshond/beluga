import { useEffect, useState, useSyncExternalStore } from 'react';
import { inApp } from './boot.js';
import { beat, usePowerSaving } from './power.js';

/**
 * Whether you're looking at Beluga's window: it's in front (focused) and not hidden, minimized or
 * covered. While it isn't, Beluga stays cool (KLD-40): `html[data-window='idle']` pauses every CSS
 * animation (base.css), the dot matrices and once-a-second clocks stop, and live polling waits.
 * Live states still arrive and render as they happen; only motion and ticking rest. Back in
 * front, everything resumes at once and pollers fetch right away.
 */

const listeners = new Set<() => void>();
let active = true;
let started = false;

const look = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

function set(next: boolean): void {
  if (next === active) return;
  active = next;
  document.documentElement.dataset.window = next ? 'active' : 'idle';
  for (const l of listeners) l();
}

/** Starts watching (once, at boot): focus and visibility from the page, and the window's focus from Tauri. */
export function watchWindow(): void {
  if (started) return;
  started = true;
  const update = (): void => set(look());
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  // A key or a click in the window: you're looking, whatever the web view last said about its
  // visibility (WebKit can keep "hidden" after the window was covered until a resize; views then
  // waited on a timer a hidden page may not run, and a sent message seemed to go nowhere, KLD-64).
  const touched = (): void => set(true);
  window.addEventListener('keydown', touched, true);
  window.addEventListener('pointerdown', touched, true);
  active = look();
  document.documentElement.dataset.window = active ? 'active' : 'idle';
  // The web view's focus events can lag the window's own (a click into Beluga from another app): Tauri says it first.
  // A focused window is in front, so it's seen even when the web view's visibility is stale.
  if (inApp())
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => set(payload)))
      .catch(() => undefined);
}

export const windowActive = (): boolean => active;

/** Called whenever you look at Beluga again, or look away. Returns a stop. */
export function onWindowActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** True while you're looking at Beluga's window (see above). */
export function useWindowActive(): boolean {
  return useSyncExternalStore(onWindowActive, windowActive, () => true);
}

/** A clock for "working · 12s": ticks every `every` ms while `running` and you're looking; on time again the moment you look back. */
export function useClock(running: boolean, every = 1000): number {
  const [now, setNow] = useState(Date.now);
  const looking = useWindowActive();
  const step = beat(every, usePowerSaving());
  useEffect(() => {
    if (!running || !looking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), step);
    return () => clearInterval(t);
  }, [running, looking, step]);
  return now;
}

/** The page can be seen: not hidden (minimized, or in another Space), or you're plainly at it (KLD-64: WebKit's "hidden" can be stale). */
export const pageShown = (): boolean => !document.hidden || active;

/**
 * `tick` every `every` ms while the page can be seen (pageShown), behind another app too. While
 * it can't, nothing wakes; once it can again, `tick` runs at once and then on its beat. Returns a stop.
 */
export function everyWhileShown(tick: () => void, every: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const update = (): void => {
    if (!pageShown()) {
      clearInterval(timer);
      timer = undefined;
    } else if (timer === undefined) {
      timer = setInterval(tick, every);
      if (started) tick();
    }
  };
  // The first beat is the caller's (it looks or reads the time itself as it starts).
  let started = false;
  update();
  started = true;
  document.addEventListener('visibilitychange', update);
  const stop = onWindowActive(update);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', update);
    stop();
  };
}
