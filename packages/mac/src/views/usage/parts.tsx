import type { ReactNode } from 'react';
import { cx } from '../../components/ui.js';
import type { ColorSlot } from './usage-model.js';
import s from './usage.module.css';

/** The CSS colour of a project's slot (see usage.module.css: --series-1…8, --series-other). */
export const slotColor = (slot: ColorSlot): string => `var(--series-${slot})`;

/** A grouped box, like a section in System Settings: a small title, then its content. */
export function Card({ title, aside, className, children, label }: { title?: ReactNode; aside?: ReactNode; className?: string; children: ReactNode; label?: string }) {
  return (
    <section className={cx(s.card, className)} aria-label={label}>
      {title || aside ? (
        <header className={s.cardHead}>
          {title ? <h2 className={s.cardTitle}>{title}</h2> : null}
          {aside ? <span className={s.cardAside}>{aside}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A chapter of the Usage tab: a heading with a line under it, its controls at the right, then what it holds, with room around it. */
export function Chapter({ title, sub, aside, label, children }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; label?: string; children: ReactNode }) {
  return (
    <section className={s.chapter} aria-label={label}>
      <header className={s.chapterHead}>
        <div className={s.chapterTitles}>
          <h2 className={s.chapterTitle}>{title}</h2>
          {sub ? <p className={s.chapterSub}>{sub}</p> : null}
        </div>
        {aside ? <div className={s.chapterAside}>{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** A thin horizontal bar: `value` of `max`, in `color`, on a faint track. */
export function Bar({ value, max, color, label }: { value: number; max: number; color: string; label?: string }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  return (
    <span className={cx(s.track, !value && s.trackEmpty)} role={label ? 'img' : undefined} aria-label={label}>
      <span className={s.fill} style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

/** Still measuring: a soft moving sheen where the number will be. */
export function Shimmer({ wide }: { wide?: boolean }) {
  return <span className={cx(s.shimmer, wide && s.shimmerWide)} aria-label="Measuring" />;
}

/** Severity of a plan window: calm, getting close, nearly out. */
export const meterTone = (pct: number): 'calm' | 'warn' | 'hot' => (pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : 'calm');

/** A plan-usage meter: how much of a window is used, coloured by how close to the limit it is. */
export function Meter({ pct, size = 'regular', label }: { pct: number; size?: 'regular' | 'mini'; label: string }) {
  const tone = meterTone(pct);
  return (
    <span className={cx(s.meter, size === 'mini' && s.meterMini, s[`meter_${tone}`])} role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className={s.meterFill} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 1.5 : 0, pct))}%` }} />
    </span>
  );
}
