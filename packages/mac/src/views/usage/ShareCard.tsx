import { useState } from 'react';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { cx } from '../../components/ui.js';
import type { GroupBy, GroupRow, MetricDef } from './stats-model.js';
import s from './stats.module.css';

/** At most this many get a slice and a row; the rest are one "more". */
const SHOWN = 6;
const R = 46;
const C = 2 * Math.PI * R;

/** The rows, with the small ones folded into one. */
function sliced(rows: readonly GroupRow[]): GroupRow[] {
  if (rows.length <= SHOWN + 1) return [...rows];
  const rest = rows.slice(SHOWN);
  const more: GroupRow = { key: '\u0000more', name: `${rest.length} more`, color: 'var(--series-other)', value: rest.reduce((n, r) => n + r.value, 0), totals: rest[0]!.totals };
  return [...rows.slice(0, SHOWN), more];
}

/** A ring of slices; the one you point at (here or in the list) stands out, and its share is in the middle. */
function Donut({ rows, m, sum, hover, onHover }: { rows: readonly GroupRow[]; m: MetricDef; sum: number; hover?: string; onHover: (key?: string) => void }) {
  let at = 0;
  const on = rows.find((r) => r.key === hover);
  return (
    <div className={s.donut}>
      <svg viewBox="0 0 120 120" role="img" aria-label={`${m.label}: ${rows.map((r) => `${r.name} ${Math.round((r.value / sum) * 100)}%`).join(', ')}`}>
        <circle cx="60" cy="60" r={R} className={s.donutTrack} />
        {rows.map((r) => {
          const len = (r.value / sum) * C;
          const gap = rows.length > 1 ? Math.min(2, len / 3) : 0;
          const el = (
            <circle
              key={r.key}
              cx="60"
              cy="60"
              r={R}
              className={cx(s.slice, hover && hover !== r.key && s.sliceDim, hover === r.key && s.sliceOn)}
              style={{ stroke: r.color, strokeDasharray: `${Math.max(0.5, len - gap)} ${C}`, strokeDashoffset: -at }}
              onMouseEnter={() => onHover(r.key)}
              onMouseLeave={() => onHover(undefined)}
            />
          );
          at += len;
          return el;
        })}
      </svg>
      <div className={s.donutMiddle} aria-hidden>
        <strong>{on ? `${Math.round((on.value / sum) * 100)}%` : m.format(sum)}</strong>
        <span>{on ? on.name : 'in all'}</span>
      </div>
    </div>
  );
}

/** Each project (or agent): a ring of their shares, and the list with a bar each; pointing at one lights it in both. */
export function Share({ rows, m, by, why }: { rows: readonly GroupRow[]; m: MetricDef; by: GroupBy; why?: string }) {
  const [hover, setHover] = useState<string | undefined>(undefined);
  if (!rows.length) return <p className={s.quiet}>{why ?? `Nothing here for ${m.label.toLowerCase()} in this stretch yet.`}</p>;
  const list = sliced(rows);
  const max = Math.max(1, ...list.map((r) => r.value));
  const sum = list.reduce((n, r) => n + r.value, 0);
  return (
    <div className={s.share}>
      <Donut rows={list} m={m} sum={sum} {...(hover ? { hover } : {})} onHover={setHover} />
      <ol className={s.ranking} aria-label={`${m.label} by ${by}`} onMouseLeave={() => setHover(undefined)}>
        {list.map((r, i) => (
          <li key={r.key} className={cx(s.rank, hover && hover !== r.key && s.rankDim)} style={{ '--g': r.color, animationDelay: `${i * 40}ms` } as React.CSSProperties} onMouseEnter={() => setHover(r.key)}>
            <span className={s.rankName}>
              {r.projectId ? <ProjectIcon id={r.projectId} name={r.name} size={16} /> : <span className={s.swatch} />}
              <span className={s.rankText}>{r.name}</span>
            </span>
            <span className={s.rankBar}>
              <span className={s.rankFill} style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
            </span>
            <span className={s.rankValue}>
              {m.format(r.value)}
              <span className={s.rankShare}>{Math.round((r.value / sum) * 100)}%</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
