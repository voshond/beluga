import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { reducedMotion } from '../lib/reduced-motion.js';
import { GLIDE_MS, type Point, between, easeOut, glidable } from './plan-layout.js';

/**
 * A plan line's points as drawn: when the plan is re-laid (a milestone folding or opening, a task
 * finishing), they glide to their new place on the cards' curve and clock, so a line stays fixed to
 * the cards it joins instead of jumping ahead of them. A line whose shape changes (more corners, or
 * a stretch turning) can't glide: it moves at once and `reshaped` counts up, for it to wait out the
 * glide hidden and fade back in. With Reduce Motion, lines move at once.
 */
export function useGlide(target: readonly Point[]): { readonly points: readonly Point[]; readonly reshaped: number } {
  const sig = target.map((p) => `${p.x},${p.y}`).join(' ');
  const [points, setPoints] = useState(target);
  const [reshaped, setReshaped] = useState(0);
  // What's on screen now (mid-glide too: a new layout glides on from there), and the layout it's heading to.
  const shown = useRef(target);
  const heading = useRef(sig);

  // Before paint, so the first frame of a new layout still shows the line where it was.
  useLayoutEffect(() => {
    if (heading.current === sig) return;
    heading.current = sig;
    const from = shown.current;
    if (reducedMotion() || !glidable(from, target)) {
      shown.current = target;
      setPoints(target);
      if (!reducedMotion()) setReshaped((n) => n + 1);
      return;
    }
    // The cards' transitions start at this frame's time (not now, after a long commit): so does the glide.
    const frameTime = document.timeline?.currentTime;
    const start = typeof frameTime === 'number' ? frameTime : performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / GLIDE_MS);
      const at = k < 1 ? between(from, target, easeOut(k)) : target;
      shown.current = at;
      // Drawn in this frame, never a frame or two behind the cards (a plain update may wait past the paint).
      flushSync(() => setPoints(at));
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [sig]);

  return { points, reshaped };
}
