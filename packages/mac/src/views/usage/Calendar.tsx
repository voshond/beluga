import { useState } from 'react';
import { dayStart } from '@beluga/shared/stats.js';
import { cx } from '../../components/ui.js';
import type { CalendarDay, MetricDef } from './stats-model.js';
import s from './stats.module.css';

const dayName = (key: string): string => new Date(dayStart(key)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** The last year, a square a day, coloured by how much of the picked metric it had. */
export function Calendar({ weeks, m, why }: { weeks: CalendarDay[][]; m: MetricDef; why?: string }) {
  const [hover, setHover] = useState<CalendarDay | undefined>(undefined);
  const months = weeks.map((w, i) => {
    const first = w.find((d) => d.key.endsWith('-01') || (i === 0 && d === w[0]));
    return first && i < weeks.length - 2 ? new Date(dayStart(first.key)).toLocaleDateString([], { month: 'short' }) : '';
  });
  const total = weeks.flat().filter((d) => d.value > 0).length;
  return (
    <div className={s.calendarWrap} style={{ '--m': m.color } as React.CSSProperties} onMouseLeave={() => setHover(undefined)}>
      <div className={s.calendar} role="grid" aria-label={`${m.label} per day, the last year`}>
        {weeks.map((w, i) => (
          <div key={w[0]!.key} className={s.week} role="row">
            <span className={s.month}>{months[i]}</span>
            {w.map((d) => (
              <span
                key={d.key}
                role="gridcell"
                aria-label={`${dayName(d.key)}: ${m.format(d.value)}`}
                className={cx(s.day, s[`level${d.level}`], d.future && s.future, hover?.key === d.key && s.dayOn)}
                onMouseEnter={() => setHover(d.future ? undefined : d)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={s.calendarFoot}>
        {hover ? (
          <span className={s.calendarHover}>
            <strong>{dayName(hover.key)}</strong> · {hover.value ? m.format(hover.value) : 'nothing'}
          </span>
        ) : (
          <span>{total ? `${total} active days in the last year` : (why ?? 'Nothing yet this year')}</span>
        )}
        <span className={s.legend} aria-hidden>
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={cx(s.day, s[`level${l}`])} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}
