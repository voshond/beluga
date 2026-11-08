import type { AppState } from '@beluga/core/store.js';
import { type StatRange, type StatsSnapshot, totalsBy } from '@beluga/shared/stats.js';
import { type Bucket, bucketsOf } from '@beluga/shared/stats-trend.js';
import { type GroupBy, type MetricDef, groupOf } from './stats-model.js';

export interface Series {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly values: readonly number[];
  readonly total: number;
}

export interface Trend {
  readonly buckets: readonly Bucket[];
  /** Biggest first (drawn at the bottom); the rest folded into "Other". */
  readonly series: readonly Series[];
}

/** At most this many groups get their own colour; the others are one "Other". */
const SHOWN = 5;
/** The picked number over a range, a step at a time, one series per project (or agent). */
export function trendOf(stats: StatsSnapshot, projects: AppState['projects'], by: GroupBy, metric: MetricDef, range: StatRange, now: number): Trend {
  const buckets = bucketsOf(range, now, stats.since);
  const values = new Map<string, number[]>();
  buckets.forEach((b, i) => {
    for (const [key, totals] of totalsBy(stats, by, b.from, b.to)) {
      const v = metric.value(totals);
      if (v <= 0) continue;
      let row = values.get(key);
      if (!row) values.set(key, (row = buckets.map(() => 0)));
      row[i] = v;
    }
  });
  const all = [...values.entries()].map(([key, vals]) => ({ key, values: vals, total: vals.reduce((a, b) => a + b, 0), ...groupOf(key, by, projects) })).sort((a, b) => b.total - a.total);
  if (all.length <= SHOWN + 1) return { buckets, series: all };
  const rest = all.slice(SHOWN);
  const other: Series = { key: '\u0000other', name: `${rest.length} more`, color: 'var(--series-other)', values: buckets.map((_, i) => rest.reduce((n, r) => n + r.values[i]!, 0)), total: rest.reduce((n, r) => n + r.total, 0) };
  return { buckets, series: [...all.slice(0, SHOWN), other] };
}
