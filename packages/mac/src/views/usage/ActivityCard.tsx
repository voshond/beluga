import { useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { type StatsSnapshot, dailySeries, dayStart, totalsOf } from '@beluga/shared/stats.js';
import type { DayTotal } from '@beluga/workspaces/usage-days.js';
import { cx } from '../../components/ui.js';
import { Card } from './parts.js';
import { groupOf } from './stats-model.js';
import { compact, formatCost } from './usage-model.js';
import s from './usage.module.css';

/** Two weeks of days: this week stands out against the one before. */
const DAYS = 14;
const WEEK = 7;

const sum = (days: readonly DayTotal[], k: 'tokens' | 'cost'): number => days.reduce((n, d) => n + d[k], 0);
const dayName = (d: DayTotal, today: boolean): string => (today ? 'Today' : new Date(d.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));

/** Change against the week before, as "↑ 18%" (nothing when there's no week before to compare). */
function delta(now: number, before: number): string | undefined {
  if (before <= 0 || now <= 0) return undefined;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return 'Same as the week before';
  return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs the week before`;
}

/** A project's tokens each day, in its colour: a column is the projects stacked, biggest at the bottom. */
interface Stack {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly days: readonly DayTotal[];
}

function DayChart({ days, stacks }: { days: readonly DayTotal[]; stacks: readonly Stack[] }) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const shown = hover !== undefined ? days[hover] : undefined;
  const parts =
    hover !== undefined
      ? stacks
          .map((st) => ({ st, tokens: st.days[hover]!.tokens }))
          .filter((x) => x.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
      : [];
  return (
    <div className={s.chart} onMouseLeave={() => setHover(undefined)}>
      <div className={s.columns} role="list" aria-label="Agent tokens per day, by project">
        {days.map((d, i) => {
          const today = i === days.length - 1;
          return (
            <div
              key={d.key}
              role="listitem"
              aria-label={`${dayName(d, today)}: ${compact(d.tokens)} tokens, ${formatCost(d.cost)}`}
              className={cx(s.column, i >= days.length - WEEK && s.columnThisWeek, hover === i && s.columnOn)}
              onMouseEnter={() => setHover(i)}
            >
              <span className={cx(s.columnBar, !d.tokens && s.columnEmpty)} style={{ height: d.tokens ? `${Math.max(4, (d.tokens / max) * 100)}%` : 2 }}>
                {stacks.map((st) => {
                  const t = st.days[i]!.tokens;
                  return t ? <span key={st.key} className={s.columnPart} style={{ flexGrow: t, background: st.color }} /> : null;
                })}
              </span>
            </div>
          );
        })}
      </div>
      <div className={s.axis}>
        {shown ? (
          <span className={s.axisHover}>
            <strong>{dayName(shown, shown === days.at(-1))}</strong> · {shown.tokens ? `${compact(shown.tokens)} tokens · ${formatCost(shown.cost)}` : 'no runs'}
            {parts.slice(0, 3).map(({ st, tokens }) => (
              <span key={st.key} className={s.axisPart}>
                <span className={s.swatch} style={{ background: st.color }} />
                {st.name} {compact(tokens)}
              </span>
            ))}
          </span>
        ) : (
          <>
            <span>{dayName(days[0]!, false)}</span>
            <span className={s.axisMid}>This week</span>
            <span>Today</span>
          </>
        )}
      </div>
    </div>
  );
}

const dayTotals = (stats: StatsSnapshot, now: number, project?: string): DayTotal[] =>
  dailySeries(stats, 'tokens', now, DAYS).map(({ key }) => {
    const counts = Object.entries(stats.days[key] ?? {})
      .filter(([root]) => project === undefined || root === project)
      .flatMap(([, agents]) => Object.values(agents));
    return { key, date: dayStart(key), tokens: counts.reduce((n, c) => n + (c.tokens ?? 0), 0), cost: counts.reduce((n, c) => n + (c.cost ?? 0), 0) };
  });

/**
 * Claude tokens and cost this week, against the week before, with a bar per day. Read from the
 * daemon's stats, which keep counting what deleted worktrees and chats spent.
 */
export function ActivityCard({ state, stats, now }: { state: AppState; stats: StatsSnapshot | undefined; now: number }) {
  if (!stats) return <Card label="Agent activity" title="Agents this week">{null}</Card>;
  const days = dayTotals(stats, now);
  const roots = [...new Set(days.flatMap((d) => Object.keys(stats.days[d.key] ?? {})))];
  // Biggest project first: it sits at the bottom of each column.
  const stacks: Stack[] = roots
    .map((root) => {
      const { name, color } = groupOf(root, 'project', state.projects);
      return { key: root, name, color, days: dayTotals(stats, now, root) };
    })
    .filter((st) => st.days.some((d) => d.tokens))
    .sort((a, b) => sum(b.days, 'tokens') - sum(a.days, 'tokens'));
  const week = days.slice(-WEEK);
  const before = days.slice(0, DAYS - WEEK);
  const today = days.at(-1)!;
  const all = totalsOf(stats, '');
  const weekTokens = sum(week, 'tokens');
  const change = delta(weekTokens, sum(before, 'tokens'));
  return (
    <Card label="Agent activity" title="Agents this week" aside={all.tokens ? <span className={s.updated}>{`${compact(all.tokens)} · ${formatCost(all.cost)} all time`}</span> : undefined}>
      {!all.tokens ? (
        <p className={s.quiet}>Nothing yet. Tokens and cost add up here as your agent works in your projects.</p>
      ) : (
        <>
          <div className={s.hero}>
            <span className={s.heroValue}>{compact(weekTokens)}</span>
            <span className={s.heroUnit}>tokens</span>
            <span className={s.heroCost}>{formatCost(sum(week, 'cost'))}</span>
          </div>
          <div className={s.heroFoot}>
            <span>
              Today <strong>{compact(today.tokens)}</strong> · {formatCost(today.cost)}
            </span>
            {change ? <span>{change}</span> : null}
          </div>
          <DayChart days={days} stacks={stacks} />
        </>
      )}
    </Card>
  );
}
