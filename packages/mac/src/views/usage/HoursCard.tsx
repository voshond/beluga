import { useMemo, useState } from 'react';
import { type StatsSnapshot, dailySeries, dayStart, streaks } from '@beluga/shared/stats.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { cx } from '../../components/ui.js';
import { type GroupBy, type GroupRow, duration, favouriteHour } from './stats-model.js';
import s from './stats.module.css';

const DAYS = Array.from({ length: 7 }, (_, d) => new Date(2026, 0, 4 + d).toLocaleDateString([], { weekday: 'short' }));

/** Prompts by weekday and hour: when you work. */
export function Hours({ hours }: { hours: readonly number[] }) {
  const max = Math.max(1, ...hours);
  const [hover, setHover] = useState<number | undefined>(undefined);
  const label = (i: number): string => `${DAYS[Math.floor(i / 24)]} ${new Date(2026, 0, 4, i % 24).toLocaleTimeString([], { hour: 'numeric' })}`;
  const none = !hours.some((n) => n > 0);
  return (
    <div className={cx(s.hours, none && s.hoursNone)} onMouseLeave={() => setHover(undefined)}>
      {none ? <p className={s.hoursEmpty}>Your prompts fill this in: which days and hours you work most.</p> : null}
      <div className={s.hoursGrid} role="grid" aria-label="Prompts by weekday and hour">
        {DAYS.map((d, day) => (
          <div key={d} className={s.hoursRow} role="row">
            <span className={s.hoursDay}>{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const i = day * 24 + h;
              const n = hours[i] ?? 0;
              return (
                <span
                  key={h}
                  role="gridcell"
                  aria-label={`${label(i)}: ${n} prompts`}
                  className={cx(s.hour, hover === i && s.dayOn)}
                  style={{ opacity: n ? 0.18 + 0.82 * (n / max) : undefined, background: n ? undefined : 'var(--track)' }}
                  onMouseEnter={() => setHover(i)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className={s.calendarFoot}>
        {hover !== undefined ? (
          <span className={s.calendarHover}>
            <strong>{label(hover)}</strong> · {(hours[hover] ?? 0).toLocaleString()} prompts
          </span>
        ) : (
          <span className={s.hoursAxis}>
            <span>12 AM</span>
            <span>6 AM</span>
            <span>12 PM</span>
            <span>6 PM</span>
            <span>11 PM</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** A few things worth knowing, as badges: a big figure and what it is. */
export function Highlights({ stats, now, rows, by }: { stats: StatsSnapshot; now: number; rows: readonly GroupRow[]; by: GroupBy }) {
  const { current, longest } = useMemo(() => streaks(stats, now), [stats, now]);
  const busiest = useMemo(() => dailySeries(stats, 'agentMs', now, 365).reduce<{ key: string; value: number } | undefined>((b, d) => (d.value > (b?.value ?? 0) ? d : b), undefined), [stats, now]);
  const hour = favouriteHour(stats.hours);
  const top = rows[0];
  const items: Array<{ icon: IconName; value: string; label: string; hot?: boolean }> = [
    { icon: 'flame', value: current ? `${current} ${current === 1 ? 'day' : 'days'}` : 'None yet', label: current ? 'Streak going' : 'Send a prompt to start a streak', hot: current > 0 },
    ...(longest > 1 ? [{ icon: 'star' as const, value: `${longest} days`, label: 'Longest streak' }] : []),
    ...(busiest ? [{ icon: 'calendar' as const, value: new Date(dayStart(busiest.key)).toLocaleDateString([], { month: 'short', day: 'numeric' }), label: `Busiest day, ${duration(busiest.value)} of agent time` }] : []),
    ...(hour ? [{ icon: 'clock' as const, value: hour.time, label: `Your busiest hour, on ${hour.day}` }] : []),
    ...(top && rows.length > 1 ? [{ icon: 'heart' as const, value: top.name, label: by === 'agent' ? 'Your top agent' : 'Your top project' }] : []),
  ];
  return (
    <ul className={s.badges} aria-label="Highlights">
      {items.map((it) => (
        <li key={it.label} className={cx(s.badge, it.hot && s.badgeHot)}>
          <Icon name={it.icon} size={15} />
          <span className={s.badgeText}>
            <strong>{it.value}</strong>
            <span>{it.label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
