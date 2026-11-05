/**
 * Someone else's pointer, gliding (BLG-733). Their Mac sends where it is many times a second, but
 * the network delivers those in bursts and gaps; drawn as they come, a pointer stutters. Each one
 * instead follows its last known spot on a critically damped spring: it never overshoots, it
 * catches up within a frame or two of a fast flick, and it never jumps. Pure.
 */

export interface Glide {
  /** Where it's drawn now (fractions of the picture). */
  readonly x: number;
  readonly y: number;
  /** How fast it moves (fractions per second). */
  readonly vx: number;
  readonly vy: number;
  /** Where it's heading: where their pointer last was. */
  readonly tx: number;
  readonly ty: number;
  /** When it last heard from them (ms, performance.now). */
  readonly at: number;
}

/** How long the spring takes to settle (seconds): short enough to keep up, long enough to hide the gaps. */
export const GLIDE_S = 0.055;
/** A pointer nobody moved for this long goes. */
export const POINTER_IDLE_MS = 4_000;
/** It fades out over this long before it goes. */
export const POINTER_FADE_MS = 600;
/** The longest frame step the spring takes (a window that slept doesn't fling pointers). */
const MAX_DT = 0.1;

/** A new spot for someone's pointer: the first one places it there at once. */
export function aim(g: Glide | undefined, x: number, y: number, now: number): Glide {
  if (!g) return { x, y, vx: 0, vy: 0, tx: x, ty: y, at: now };
  return { ...g, tx: x, ty: y, at: now };
}

/** One axis of a critically damped spring (Game Programming Gems 4, 1.10): the new spot and speed. */
export function damp(cur: number, target: number, vel: number, smooth: number, dt: number): readonly [number, number] {
  const omega = 2 / smooth;
  const k = omega * dt;
  const decay = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  return [target + (change + temp) * decay, (vel - omega * temp) * decay];
}

/** The pointer `dt` seconds on. */
export function step(g: Glide, dt: number, smooth = GLIDE_S): Glide {
  const t = Math.min(MAX_DT, Math.max(0, dt));
  if (t === 0) return g;
  const [x, vx] = damp(g.x, g.tx, g.vx, smooth, t);
  const [y, vy] = damp(g.y, g.ty, g.vy, smooth, t);
  return { ...g, x, y, vx, vy };
}

/** How visible it is now: whole while they move it, fading once it rested `POINTER_IDLE_MS`. */
export function glideAlpha(g: Glide, now: number): number {
  const idle = now - g.at - POINTER_IDLE_MS;
  return idle <= 0 ? 1 : Math.max(0, 1 - idle / POINTER_FADE_MS);
}

/** Whether it has settled where it's heading (nothing left to draw until they move again). */
export const settled = (g: Glide): boolean => Math.abs(g.x - g.tx) < 1e-4 && Math.abs(g.y - g.ty) < 1e-4 && Math.abs(g.vx) < 1e-3 && Math.abs(g.vy) < 1e-3;
