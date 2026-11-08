/**
 * Your pass on the Usage tab's lanyard (YourCard.tsx), drawn on canvases. The front: a bold band
 * in your title's colour with a big beluga in it, Beluga's logo, your picture, name, title, three
 * numbers and your week as a barcode. The back: night blue, the logo large, your year as dots
 * and your pass number. The strap: Beluga's name and the beluga along it. Each a PNG data URL.
 */
import { BELUGA } from '../../components/beluga-path.js';

/** The card is 1.6 × 2.25 (components/reactbits/Lanyard.tsx): drawn at this size. */
export const CARD_W = 1024;
export const CARD_H = 1440;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const INK = '#18181d';
const SOFT = '#6b6b76';
const NIGHT = '#15161b';
/** The logo's tile (onboarding/Mark.tsx), in the same 1024 box as the beluga. */
const TILE = 'M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z';

export interface CardFace {
  readonly name: string;
  readonly title: string;
  /** The title's colour (hex). */
  readonly color: string;
  /** Your picture, loaded; none: your initial on your colour. */
  readonly picture?: HTMLImageElement;
  /** Your colour, for the initial. */
  readonly personColor: string;
  readonly figures: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** Prompts by weekday × hour (168). */
  readonly hours: readonly number[];
  /** The last 52 weeks × 7 days, 0–4 how busy. */
  readonly year: ReadonlyArray<readonly number[]>;
  readonly since: string;
  /** A number that's yours (your pass number on the back). */
  readonly serial: string;
  /** Active days, for the back. */
  readonly active: number;
}

// ---------------------------------------------------------------- colour

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** `hex` at `alpha` as rgba(). */
export function tint(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
/** `hex` mixed toward black (amount > 0) or white (amount < 0). */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex);
  const to = amount > 0 ? 0 : 255;
  const f = Math.abs(amount);
  const m = (c: number) => Math.round(c + (to - c) * f);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

// ---------------------------------------------------------------- drawing

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Text no wider than `max`: smaller until it fits (to 60%), then cut with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number): string {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > max && s > size * 0.6) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** The beluga at (x, y), `size` wide (its 1024 box), in `fill`. */
export function drawBeluga(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill: string, rotate = 0): void {
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate(rotate);
  ctx.scale(size / 1024, size / 1024);
  ctx.translate(-512, -512);
  ctx.fillStyle = fill;
  ctx.fill(new Path2D(BELUGA), 'evenodd');
  ctx.restore();
}

/** Beluga's logo: the dark tile with the white beluga, `size` square at (x, y). */
export function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 1024, size / 1024);
  const tile = new Path2D(TILE);
  const g = ctx.createLinearGradient(0, 0, 0, 1024);
  g.addColorStop(0, '#2a2c31');
  g.addColorStop(1, '#0f1013');
  ctx.fillStyle = g;
  ctx.fill(tile);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 6;
  ctx.stroke(tile);
  ctx.clip(tile);
  ctx.translate(512, 512);
  ctx.scale(0.76, 0.76);
  ctx.translate(-512, -512);
  ctx.fillStyle = '#f5f5f7';
  ctx.fill(new Path2D(BELUGA), 'evenodd');
  ctx.restore();
}

/** The logo and "BELUGA" beside it, letter-spaced, at (x, y) (the logo's top left). */
function wordmark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  drawLogo(ctx, x, y, size);
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `800 ${Math.round(size * 0.42)}px ${FONT}`;
  ctx.letterSpacing = `${Math.round(size * 0.1)}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('BELUGA', x + size * 1.22, y + size / 2 + 2);
  ctx.restore();
}

/** Your picture in a white ring (or your initial on your colour). */
function portrait(ctx: CanvasRenderingContext2D, f: CardFace, cx: number, cy: number, r: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (f.picture) {
    const s = Math.max((2 * r) / f.picture.width, (2 * r) / f.picture.height);
    ctx.drawImage(f.picture, cx - (f.picture.width * s) / 2, cy - (f.picture.height * s) / 2, f.picture.width * s, f.picture.height * s);
  } else {
    ctx.fillStyle = f.personColor;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.fillStyle = '#ffffff';
    ctx.font = `750 ${Math.round(r * 0.9)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((f.name[0] ?? '?').toUpperCase(), cx, cy + r * 0.04);
  }
  ctx.restore();
}

/** The band at the top of the front: the title's colour, deep at the top, a big beluga leaping across it. */
function band(ctx: CanvasRenderingContext2D, color: string, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, shade(color, 0.28));
  g.addColorStop(0.55, color);
  g.addColorStop(1, shade(color, -0.35));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Soft rings, like ripples.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 3;
  for (const r of [220, 330, 440]) {
    ctx.beginPath();
    ctx.arc(w * 0.12, h * 0.95, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  drawBeluga(ctx, w * 0.36, -h * 0.08, w * 0.86, 'rgba(255,255,255,0.2)', -0.12);
}

export function drawFront(f: CardFace): string {
  const W = CARD_W;
  const H = CARD_H;
  const BAND = 600;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#fbfbfd';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, BAND);
  ctx.clip();
  band(ctx, f.color, W, BAND);
  ctx.restore();
  // The hole the clip goes through.
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  roundRect(ctx, W / 2 - 92, 50, 184, 36, 18);
  ctx.fill();
  wordmark(ctx, 72, 132, 76, '#ffffff');
  // The pass's kind, in a pill at the right.
  ctx.font = `700 26px ${FONT}`;
  ctx.letterSpacing = '4px';
  const tag = 'USAGE PASS';
  const tw = ctx.measureText(tag).width + 44;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  roundRect(ctx, W - 72 - tw, 145, tw, 50, 25);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tag, W - 72 - tw / 2, 171);
  ctx.letterSpacing = '0px';
  ctx.textBaseline = 'alphabetic';
  portrait(ctx, f, W / 2, BAND, 168);
  // Name, then the title in a solid pill.
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  const name = fit(ctx, f.name, 800, 88, W - 150);
  ctx.fillText(name, W / 2, 878);
  ctx.font = `750 46px ${FONT}`;
  const title = fit(ctx, f.title, 750, 46, W - 260);
  const pw = Math.min(W - 160, ctx.measureText(title).width + 110);
  ctx.fillStyle = shade(f.color, 0.12);
  roundRect(ctx, W / 2 - pw / 2, 916, pw, 92, 46);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, W / 2, 964);
  ctx.textBaseline = 'alphabetic';
  // Three numbers, with hairlines between.
  const col = (W - 144) / 3;
  f.figures.slice(0, 3).forEach((fig, i) => {
    const x = 72 + col * i + col / 2;
    ctx.fillStyle = INK;
    ctx.fillText(fit(ctx, fig.value, 800, 72, col - 24), x, 1124);
    ctx.fillStyle = SOFT;
    ctx.font = `600 27px ${FONT}`;
    ctx.fillText(fit(ctx, fig.label.toUpperCase(), 600, 27, col - 16), x, 1166);
    if (i) {
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(72 + col * i, 1062, 2, 116);
    }
  });
  // Your week, hour by hour, as a barcode.
  const max = Math.max(1, ...f.hours);
  const bw = (W - 144) / f.hours.length;
  f.hours.forEach((n, i) => {
    const h = 6 + (n / max) * 80;
    ctx.fillStyle = n ? INK : 'rgba(0,0,0,0.1)';
    ctx.globalAlpha = n ? 0.35 + 0.65 * (n / max) : 1;
    ctx.fillRect(72 + i * bw, 1318 - h, Math.max(1, bw - 1.6), h);
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = SOFT;
  ctx.font = `600 23px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('YOUR WEEK, HOUR BY HOUR', 72, 1364);
  ctx.textAlign = 'right';
  ctx.fillText(f.since.toUpperCase(), W - 72, 1364);
  return c.toDataURL('image/png');
}

export function drawBack(f: CardFace): string {
  const W = CARD_W;
  const H = CARD_H;
  const [c, ctx] = canvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#20222a');
  g.addColorStop(1, NIGHT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // A wash of the title's colour from the top, and big rings.
  const wash = ctx.createRadialGradient(W / 2, 0, 40, W / 2, 0, 900);
  wash.addColorStop(0, tint(f.color, 0.55));
  wash.addColorStop(1, tint(f.color, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 2;
  for (const r of [260, 380, 500, 620]) {
    ctx.beginPath();
    ctx.arc(W / 2, 380, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(ctx, W / 2 - 92, 50, 184, 36, 18);
  ctx.fill();
  // The logo, large, and the pass's name.
  drawLogo(ctx, W / 2 - 150, 210, 300);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 64px ${FONT}`;
  ctx.letterSpacing = '18px';
  ctx.fillText('BELUGA', W / 2 + 9, 610);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `600 28px ${FONT}`;
  ctx.letterSpacing = '6px';
  ctx.fillText(`PASS Nº ${f.serial}`, W / 2 + 3, 664);
  ctx.letterSpacing = '0px';
  // Your year: 52 weeks across, 7 days down, a dot a day.
  const weeks = f.year.length || 1;
  const step = (W - 144) / weeks;
  const top = 760;
  f.year.forEach((week, w) =>
    week.forEach((level, d) => {
      ctx.fillStyle = level ? tint(f.color, 0.3 + level * 0.175) : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.arc(72 + w * step + step / 2, top + d * step * 1.5, Math.max(2, step * 0.36), 0, Math.PI * 2);
      ctx.fill();
    }),
  );
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('YOUR YEAR, A DOT A DAY', 72, top + 7 * step * 1.5 + 24);
  ctx.textAlign = 'right';
  ctx.fillText(`${f.active.toLocaleString()} ACTIVE DAYS`, W - 72, top + 7 * step * 1.5 + 24);
  // Who carries it.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `750 44px ${FONT}`;
  ctx.fillText(fit(ctx, f.title, 750, 44, W - 144), 72, 1200);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(fit(ctx, `${f.name} · ${f.since}`, 500, 28, W - 144), 72, 1246);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(72, 1306);
  ctx.lineTo(W - 72, 1306);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `600 22px ${FONT}`;
  ctx.letterSpacing = '4px';
  ctx.fillText('GRAB ME · SWING ME · CLICK TO FLIP', 72, 1352);
  ctx.letterSpacing = '0px';
  return c.toDataURL('image/png');
}

/** The strap: Beluga's name and the beluga along it, on the title's colour. */
export function drawStrap(color: string): string {
  const [c, ctx] = canvas(1024, 192);
  const g = ctx.createLinearGradient(0, 0, 0, 192);
  g.addColorStop(0, shade(color, 0.08));
  g.addColorStop(1, shade(color, 0.22));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 192);
  // Stitching at both edges.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let x = 0; x < 1024; x += 22) {
    ctx.fillRect(x, 16, 12, 3);
    ctx.fillRect(x, 173, 12, 3);
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 62px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '14px';
  ctx.fillText('BELUGA', 70, 100);
  ctx.fillText('BELUGA', 582, 100);
  ctx.letterSpacing = '0px';
  for (const x of [400, 912]) drawBeluga(ctx, x, 34, 124, '#ffffff');
  return c.toDataURL('image/png');
}

/** Load an image (your picture) so it can be drawn; undefined when it can't be. */
export function loadPicture(url: string | undefined): Promise<HTMLImageElement | undefined> {
  if (!url) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = url;
  });
}
