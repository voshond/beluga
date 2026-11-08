import { type MouseEvent, useMemo, useRef, useState } from 'react';
import { cx } from '../../components/ui.js';
import { type DitherBand, DitherFill } from './DitherFill.js';
import type { MetricDef } from './stats-model.js';
import { smoothPath } from '@beluga/shared/stats-trend.js';
import type { Trend } from './trend-model.js';
import s from './stats.module.css';

/** Stacked: how much in all; Share: who did what part of each step (every step 100%). */
export type TrendMode = 'stacked' | 'share';

const W = 1000;
const H = 200;
/** Room above the highest step, so its line isn't cut. */
const TOP = 0.92;

/** Where each visible series sits in each step: from its bottom to its top, in the chart's units. */
function layers(trend: Trend, hidden: ReadonlySet<string>, mode: TrendMode): { key: string; low: number[]; high: number[] }[] {
  const shown = trend.series.filter((x) => !hidden.has(x.key));
  const n = trend.buckets.length;
  const sums = Array.from({ length: n }, (_, i) => shown.reduce((t, x) => t + x.values[i]!, 0));
  const peak = mode === 'share' ? 1 : Math.max(1e-9, ...sums);
  const cum = Array.from({ length: n }, () => 0);
  return shown.map((x) => {
    const low = cum.slice();
    for (let i = 0; i < n; i++) cum[i]! += mode === 'share' ? (sums[i] ? x.values[i]! / sums[i]! : 0) : x.values[i]!;
    const high = cum.slice();
    return { key: x.key, low: low.map((v) => v / peak), high: high.map((v) => v / peak) };
  });
}

const xAt = (i: number, n: number): number => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
const yAt = (f: number): number => H - f * H * TOP;

/** An area between two lines through the steps, smooth and never overshooting. */
function areaPath(low: readonly number[], high: readonly number[]): string {
  const n = high.length;
  const top = high.map((f, i) => [xAt(i, n), yAt(f)] as const);
  const bottom = low.map((f, i) => [xAt(i, n), yAt(f)] as const).reverse();
  return `M${top[0]![0]},${top[0]![1]}${smoothPath(top)} L${bottom[0]![0]},${bottom[0]![1]}${smoothPath(bottom)} Z`;
}

function linePath(high: readonly number[]): string {
  const n = high.length;
  const pts = high.map((f, i) => [xAt(i, n), yAt(f)] as const);
  return `M${pts[0]![0]},${pts[0]![1]}${smoothPath(pts)}`;
}

/**
 * The picked number over the range, one band per project (or agent), stacked. Point at it for that
 * step's numbers; press a name below to leave it out (or bring it back); point at a name to see
 * only its band. Share shows each one's part of every step instead of how much.
 */
export function TrendChart({ trend, m, mode, animate, why }: { trend: Trend; m: MetricDef; mode: TrendMode; animate: string; why?: string }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [hover, setHover] = useState<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const n = trend.buckets.length;
  const bands = useMemo(() => layers(trend, hidden, mode), [trend, hidden, mode]);
  const fills = useMemo<DitherBand[]>(
    () =>
      bands.map((band) => ({
        key: band.key,
        d: areaPath(band.low, band.high),
        color: trend.series.find((y) => y.key === band.key)!.color,
        top: Math.min(...band.high.map(yAt)),
        ...(focus !== undefined && focus !== band.key ? { dim: true } : {}),
        ...(focus === band.key ? { on: true } : {}),
      })),
    [bands, trend.series, focus],
  );
  const shown = trend.series.filter((x) => !hidden.has(x.key));
  const peak = Math.max(0, ...trend.buckets.map((_, i) => shown.reduce((t, x) => t + x.values[i]!, 0)));
  const toggle = (key: string): void =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      // Never all of them: one is always left to see.
      else if (next.size < trend.series.length - 1) next.add(key);
      return next;
    });
  const onMove = (e: MouseEvent): void => {
    const r = box.current?.getBoundingClientRect();
    if (!r || n < 1) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  if (!trend.series.length) return <p className={s.quiet}>{why ?? `Nothing yet for ${m.label.toLowerCase()} in this stretch.`}</p>;
  const b = hover !== undefined ? trend.buckets[hover] : undefined;
  const at = hover !== undefined ? (n <= 1 ? 50 : (hover / (n - 1)) * 100) : 0;
  const stepTotal = hover !== undefined ? shown.reduce((t, x) => t + x.values[hover]!, 0) : 0;
  const label = m.axis ?? m.format;
  const grid = mode === 'share' ? ['100%', '50%', '0%'] : [label(Math.round(peak / TOP)), label(Math.round(peak / TOP / 2)), ''];
  return (
    <div className={s.trend}>
      <div className={s.trendPlot}>
        <div className={s.trendGrid} aria-hidden>
          {grid.map((g, i) => (
            <span key={i} className={s.trendGridLine}>
              <span>{g}</span>
            </span>
          ))}
        </div>
        <div ref={box} className={s.trendBox} onMouseMove={onMove} onMouseLeave={() => setHover(undefined)} role="img" aria-label={`${m.label} over time: ${shown.map((x) => `${x.name} ${m.format(x.total)}`).join(', ')}`}>
          <div key={animate} className={s.trendDraw}>
            {/* The bands' fill: dithered, dense at each band's peak and thinning out to the bottom. */}
            <DitherFill bands={fills} width={W} height={H} className={s.trendDither} />
            <svg className={s.trendSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {bands.map((band) => {
                const x = trend.series.find((y) => y.key === band.key)!;
                const dim = focus !== undefined && focus !== band.key;
                return (
                  <g key={band.key} className={cx(s.band, dim && s.bandDim)} style={{ '--g': x.color } as React.CSSProperties}>
                    <path d={linePath(band.high)} className={s.bandLine} vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
            </svg>
          </div>
          {hover !== undefined && b ? (
            <>
              <span className={s.crosshair} style={{ left: `${at}%` }} />
              {bands.map((band) => {
                const x = trend.series.find((y) => y.key === band.key)!;
                return x.values[hover] ? <span key={band.key} className={s.dot} style={{ left: `${at}%`, top: `${(yAt(band.high[hover]!) / H) * 100}%`, background: x.color }} /> : null;
              })}
              <div className={cx(s.tip, at > 60 && s.tipLeft)} style={{ left: `${at}%` }}>
                <div className={s.tipHead}>
                  <strong>{b.label}</strong>
                  <span>{m.format(stepTotal)}</span>
                </div>
                {shown
                  .filter((x) => x.values[hover]! > 0)
                  .sort((p, q) => q.values[hover]! - p.values[hover]!)
                  .map((x) => (
                    <div key={x.key} className={s.tipRow}>
                      <span className={s.tipName}>
                        <span className={s.swatch} style={{ '--g': x.color } as React.CSSProperties} />
                        {x.name}
                      </span>
                      <span>{mode === 'share' && stepTotal ? `${Math.round((x.values[hover]! / stepTotal) * 100)}%` : m.format(x.values[hover]!)}</span>
                    </div>
                  ))}
                {!stepTotal ? <div className={s.tipRow}>Nothing this time</div> : null}
              </div>
            </>
          ) : null}
        </div>
        <div className={s.ticks} aria-hidden>
          {trend.buckets.map((bk, i) =>
            bk.tick ? (
              <span key={bk.from} style={{ left: `${n <= 1 ? 50 : (i / (n - 1)) * 100}%` }}>
                {bk.tick}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div className={s.legend2} role="group" aria-label="Show or hide">
        {trend.series.map((x) => {
          const off = hidden.has(x.key);
          return (
            <button
              key={x.key}
              type="button"
              aria-pressed={!off}
              className={cx(s.chip, off && s.chipOff)}
              style={{ '--g': x.color } as React.CSSProperties}
              onClick={() => toggle(x.key)}
              onMouseEnter={() => !off && setFocus(x.key)}
              onMouseLeave={() => setFocus(undefined)}
              title={off ? `Show ${x.name}` : `Hide ${x.name}`}
            >
              <span className={s.swatch} />
              {x.name}
              <span className={s.chipValue}>{m.format(x.total)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
