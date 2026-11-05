import { useEffect, useRef, useState } from 'react';
import { personColor } from '../components/ui.js';
import { draw, drawPointer, hasInk, tidyInk } from '../call/ink.js';
import { type Glide, aim, step } from '../call/glide.js';
import { PROBE_PX } from '../call/leak-probe.js';
import { PopList } from '../call/PopList.js';
import type { OverlayState } from '../call/overlay.js';
import s from './overlay.module.css';

/** Hear what to show (now, and as it changes), from Beluga's window through the shell. */
function useOverlayState(): { state: OverlayState | null; offset: number } {
  const [got, setGot] = useState<{ state: OverlayState | null; offset: number }>({ state: null, offset: 0 });
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    // The two windows' clocks differ: line this one up with the sender's on each update.
    const take = (state: OverlayState | null): void => setGot({ state, offset: state ? performance.now() - state.now : 0 });
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<OverlayState | null>('call-overlay', (e) => take(e.payload)))
      .then(async (un) => {
        if (!alive) return un();
        off = un;
        const { invoke } = await import('@tauri-apps/api/core');
        take(await invoke<OverlayState | null>('call_overlay_state'));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return got;
}

/**
 * Over the screen you share (BLG-717): a soft frame that says it's on show, the others' sketches,
 * pointers and clicks where they made them, and what they write in the chat, bottom right,
 * dissolving. Nothing here takes the mouse. Pointers glide between updates (call/glide.ts).
 */
export function CallOverlay() {
  const { state, offset } = useOverlayState();
  const canvas = useRef<HTMLCanvasElement>(null);
  const glides = useRef(new Map<string, Glide>());
  const lastFrame = useRef(0);

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext('2d');
    if (!el || !g) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(window.innerWidth * dpr);
    el.height = Math.round(window.innerHeight * dpr);
    const ink = state?.ink;
    if (!ink) {
      glides.current.clear();
      g.clearRect(0, 0, el.width, el.height);
      return;
    }
    // Each pointer heads for where it is now; ones that went, go.
    const here = performance.now();
    for (const by of [...glides.current.keys()]) if (!ink.lasers[by]) glides.current.delete(by);
    for (const [by, l] of Object.entries(ink.lasers)) glides.current.set(by, aim(glides.current.get(by), l.x, l.y, here));
    // Times in the ink are the sharer's: this window's clock, moved back by the offset.
    let raf = 0;
    const tick = (): void => {
      const t = performance.now();
      const dt = lastFrame.current ? (t - lastFrame.current) / 1000 : 0;
      lastFrame.current = t;
      const now = t - offset;
      const tidy = tidyInk(ink, now);
      const W = window.innerWidth;
      const H = window.innerHeight;
      draw(g, { ...tidy, lasers: {} }, { x: 0, y: 0, w: W, h: H }, now, personColor, dpr);
      for (const [by, glide] of glides.current) {
        const next = step(glide, dt);
        glides.current.set(by, next);
        drawPointer(g, next.x * W * dpr, next.y * H * dpr, personColor(by), dpr);
      }
      if (hasInk(tidy) || glides.current.size) raf = requestAnimationFrame(tick);
      else lastFrame.current = 0;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [state, offset]);

  return (
    <div className={s.overlay}>
      <canvas ref={canvas} className={s.ink} aria-hidden="true" />
      {state?.frame ? <div className={s.frame} aria-hidden="true" /> : null}
      {/* While Beluga checks the overlay stays out of what's shared (call/leak-probe.ts): under the screen's corner. */}
      {state?.probe ? <div className={s.probe} style={{ background: state.probe, width: PROBE_PX, height: PROBE_PX }} aria-hidden="true" /> : null}
      {state ? <PopList pops={state.pops} now={Date.now()} className={s.pops} /> : null}
    </div>
  );
}
