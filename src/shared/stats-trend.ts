/**
 * The Usage tab's trend (BLG-755): the steps a range is drawn in, and the smooth line through them.
 * Browser-safe, no imports at runtime.
 */
import { type StatRange, rangeStart, shiftDay, statDay, dayStart } from './stats.js';

/** One step of the trend: a day, a week or a month. */
export interface Bucket {
  /** First day (inclusive) and the day after the last, as day keys. */
  readonly from: string;
  readonly to: string;
  readonly label: string;
  /** For the axis: a shorter name, or nothing when it would crowd. */
  readonly tick: string;
}

const short = (key: string, o: Intl.DateTimeFormatOptions): string => new Date(dayStart(key)).toLocaleDateString([], o);

/** The steps a range is drawn in: days for a week or a month, weeks for a year, months for all time. */
export function bucketsOf(range: StatRange, now: number, since: number): Bucket[] {
  const today = statDay(now);
  const tomorrow = shiftDay(today, 1);
  if (range === 'week' || range === 'month') {
    const start = rangeStart(range, now);
    const n = range === 'week' ? 7 : 30;
    return Array.from({ length: n }, (_, i) => {
      const from = shiftDay(start, i);
      const tick = range === 'week' ? short(from, { weekday: 'short' }) : i % 5 === 0 || i === n - 1 ? short(from, { month: 'short', day: 'numeric' }) : '';
      return { from, to: shiftDay(from, 1), label: short(from, { weekday: 'long', month: 'short', day: 'numeric' }), tick };
    });
  }
  if (range === 'year') {
    // 52 weeks ending today: each a week up to (and including) its last day; a month's name where one starts.
    let last = -9;
    return Array.from({ length: 52 }, (_, i) => {
      const to = shiftDay(tomorrow, -7 * (51 - i));
      const from = shiftDay(to, -7);
      const newMonth = short(from, { month: 'short' }) !== short(shiftDay(from, -7), { month: 'short' });
      const tick = newMonth && i - last >= 3 ? short(from, { month: 'short' }) : '';
      if (tick) last = i;
      return { from, to, label: `Week of ${short(from, { month: 'short', day: 'numeric' })}`, tick };
    });
  }
  // All time: a month each, from the first month anything was counted (at least six).
  const d = new Date(now);
  const first = since ? new Date(since) : d;
  const months = Math.min(36, Math.max(6, (d.getFullYear() - first.getFullYear()) * 12 + d.getMonth() - first.getMonth() + 1));
  return Array.from({ length: months }, (_, i) => {
    const start = new Date(d.getFullYear(), d.getMonth() - (months - 1 - i), 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const from = statDay(start.getTime());
    return { from, to: statDay(end.getTime()), label: start.toLocaleDateString([], { month: 'long', year: 'numeric' }), tick: i % Math.ceil(months / 8) === 0 ? start.toLocaleDateString([], { month: 'short' }) : '' };
  });
}

/**
 * A smooth line through points that never overshoots (monotone cubic, Fritsch–Carlson), as SVG path
 * commands after the first point: a stacked area stays honest about where it goes.
 */
export function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length;
  if (n < 2) return '';
  const dx = (i: number) => points[i + 1]![0] - points[i]![0];
  const slope = (i: number) => (points[i + 1]![1] - points[i]![1]) / (dx(i) || 1);
  const m: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) m.push(slope(0));
    else if (i === n - 1) m.push(slope(n - 2));
    else {
      const a = slope(i - 1);
      const b = slope(i);
      m.push(a * b <= 0 ? 0 : (3 * (dx(i - 1) + dx(i))) / ((2 * dx(i) + dx(i - 1)) / a + (dx(i) + 2 * dx(i - 1)) / b));
    }
  }
  let d = '';
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = (x1 - x0) / 3;
    d += ` C${x0 + h},${y0 + m[i]! * h} ${x1 - h},${y1 - m[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}
