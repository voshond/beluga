import { useEffect, useRef, useState } from 'react';

/**
 * The trend's bands filled with a dithered gradient (TrendChart.tsx): a grid of small square dots
 * in the band's colour, dense at the band's peak and thinning out to the bottom, like an old print
 * or a pixel screen. Ordered (Bayer) dithering: a 4 × 4 threshold tile, one pattern per density,
 * each laid in the horizontal strip of the band where that density belongs. Drawn on a canvas
 * under the lines, again only when the bands, the size, the theme or what's pointed at change.
 */

/** A band to fill: its outline (an SVG path in the chart's units), colour (any CSS colour), and where its peak is. */
export interface DitherBand {
  readonly key: string;
  readonly d: string;
  readonly color: string;
  /** The band's highest point, in the chart's units (0 at the top). */
  readonly top: number;
  readonly dim?: boolean;
  readonly on?: boolean;
}

/** One dot is this many CSS pixels square. */
const DOT = 2;
/** The Bayer matrix: which dots of a 4 × 4 tile light up first as the density rises. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;
const LEVELS = 16;
/** How dense the dots are at the band's peak and at the bottom (0–1). */
const DENSE = 0.82;
const SPARSE = 0.04;

/** A CSS colour (a var() too) as the browser computes it. */
function resolve(color: string, host: Element): string {
  const probe = document.createElement('span');
  probe.style.color = color;
  probe.style.display = 'none';
  host.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/** The tile for one density: `level` of the 16 dots lit, in `color`, each DOT × dpr pixels. */
function tile(ctx: CanvasRenderingContext2D, color: string, level: number, px: number): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = c.height = 4 * px;
  const t = c.getContext('2d')!;
  t.fillStyle = color;
  BAYER.forEach((rank, i) => {
    if (rank < level) t.fillRect((i % 4) * px, Math.floor(i / 4) * px, px, px);
  });
  return ctx.createPattern(c, 'repeat');
}

export function DitherFill({ bands, width, height, className }: { bands: readonly DitherBand[]; width: number; height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    // The colours are the theme's: drawn again when it changes.
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? ''));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const px = Math.max(1, Math.round(DOT * dpr));
    const sx = canvas.width / width;
    const sy = canvas.height / height;
    // Strips one dot-tile tall, so the density steps down in even bands.
    const strip = 4 * px;
    for (const band of bands) {
      const color = resolve(band.color, canvas);
      const patterns = Array.from({ length: LEVELS + 1 }, (_, l) => (l ? tile(ctx, color, l, px) : null));
      ctx.save();
      ctx.globalAlpha = band.dim ? 0.22 : band.on ? 1 : 0.88;
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.clip(new Path2D(band.d));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const top = Math.max(0, Math.floor((band.top * sy) / strip) * strip);
      const span = Math.max(1, canvas.height - top);
      for (let y = top; y < canvas.height; y += strip) {
        const f = (y + strip / 2 - top) / span;
        const level = Math.round((DENSE + (SPARSE - DENSE) * f) * LEVELS);
        const pattern = patterns[Math.max(0, Math.min(LEVELS, level))];
        if (!pattern) continue;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, y, canvas.width, strip);
      }
      ctx.restore();
    }
  }, [bands, size, theme, width, height]);
  return <canvas ref={ref} className={className} aria-hidden />;
}
