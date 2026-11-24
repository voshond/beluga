import type { CardWindow } from './usage-cards.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type WindowShape = { readonly length: number; readonly segments: number; readonly settle: number };

const SHAPES: Readonly<Record<string, WindowShape>> = {
  '5-hour': { length: 5 * HOUR, segments: 5, settle: 10 * MINUTE },
  Weekly: { length: 7 * DAY, segments: 7, settle: HOUR },
};

export type Pressure = 'calm' | 'warm' | 'hot';

export type WindowPace = {
  readonly window: CardWindow;
  readonly segments: number;
  readonly elapsed?: number;
  readonly projected?: number;
  readonly pressure: Pressure;
};

const clamp = (pct: number): number => Math.min(100, Math.max(0, pct));

const pressureOf = (pct: number, projected: number | undefined): Pressure => {
  const ahead = projected ?? pct;
  if (pct >= 90 || ahead >= 100) return 'hot';
  if (pct >= 70 || ahead >= 85) return 'warm';
  return 'calm';
};

export const paceOf = (window: CardWindow, now: number): WindowPace => {
  const shape = SHAPES[window.label];
  if (!shape || !window.resetsAt || window.resetsAt <= now) return { window, segments: shape?.segments ?? 0, pressure: pressureOf(window.pct, undefined) };
  const spent = shape.length - (window.resetsAt - now);
  if (spent < shape.settle) return { window, segments: shape.segments, pressure: pressureOf(window.pct, undefined) };
  const elapsed = clamp((spent / shape.length) * 100);
  const projected = Math.round(clamp(Math.max(window.pct, (window.pct * shape.length) / spent)));
  return { window, segments: shape.segments, elapsed, projected, pressure: pressureOf(window.pct, projected) };
};

export const worstPressure = (paces: readonly WindowPace[]): Pressure | undefined => {
  if (!paces.length) return undefined;
  if (paces.some((p) => p.pressure === 'hot')) return 'hot';
  if (paces.some((p) => p.pressure === 'warm')) return 'warm';
  return 'calm';
};

export const paceLine = (pace: WindowPace): string => {
  const used = `${pace.window.label}: ${pace.window.pct}% used`;
  if (pace.projected === undefined) return used;
  if (pace.projected >= 100) return `${used}, on pace to run out before it resets`;
  return `${used}, on pace for ${pace.projected}% by reset`;
};
