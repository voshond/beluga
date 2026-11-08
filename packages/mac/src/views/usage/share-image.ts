/**
 * The picture of your stats to share (Share… on the Usage tab), Wrapped-style: 1080 × 1350, your
 * title's colour, your pass tilted at the top, what you're called in big letters, four numbers,
 * and Beluga's logo. Drawn on a canvas; nothing leaves the Mac unless you send it.
 */
import { drawBeluga, drawLogo, shade } from './card-face.js';

export const SHARE_W = 1080;
export const SHARE_H = 1350;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

export interface ShareInput {
  /** The pass's front (a PNG data URL from card-face.ts). */
  readonly front: string;
  readonly title: string;
  readonly why: string;
  readonly color: string;
  readonly figures: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly since: string;
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The pass couldn’t be drawn'));
    img.src = url;
  });
}

function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number): void {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > max && s > 24) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
}

/** The picture, as a PNG data URL. */
export async function drawShare(x: ShareInput): Promise<string> {
  const c = document.createElement('canvas');
  c.width = SHARE_W;
  c.height = SHARE_H;
  const ctx = c.getContext('2d')!;
  // A bold wash of the title's colour, ripples, and a big beluga leaping across.
  const g = ctx.createLinearGradient(0, 0, SHARE_W, SHARE_H);
  g.addColorStop(0, shade(x.color, -0.25));
  g.addColorStop(0.5, x.color);
  g.addColorStop(1, shade(x.color, 0.32));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SHARE_W, SHARE_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 3;
  for (const r of [260, 400, 540, 680]) {
    ctx.beginPath();
    ctx.arc(SHARE_W * 0.85, SHARE_H * 0.18, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  drawBeluga(ctx, -180, SHARE_H - 760, 900, 'rgba(255,255,255,0.12)', -0.1);
  // The logo and name, top left.
  drawLogo(ctx, 72, 68, 84);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 36px ${FONT}`;
  ctx.letterSpacing = '9px';
  ctx.textBaseline = 'middle';
  ctx.fillText('BELUGA', 178, 112);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'right';
  ctx.font = `650 28px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(x.since, SHARE_W - 72, 112);
  // Your pass, tilted, with a soft shadow under it.
  const pass = await load(x.front);
  const pw = 360;
  const ph = (pass.height / pass.width) * pw;
  ctx.save();
  ctx.translate(SHARE_W - 240, 470);
  ctx.rotate(0.12);
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.beginPath();
  ctx.roundRect(-pw / 2, -ph / 2, pw, ph, 30);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  ctx.drawImage(pass, -pw / 2, -ph / 2, pw, ph);
  ctx.restore();
  // What you are.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `650 40px ${FONT}`;
  ctx.fillText('I’m a', 72, 300);
  ctx.fillStyle = '#ffffff';
  const words = x.title.split(' ');
  const lines = words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [x.title];
  lines.forEach((line, i) => {
    fit(ctx, line, 850, 112, 500);
    ctx.fillText(line, 66, 418 + i * 118);
  });
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  fit(ctx, x.why, 550, 32, 500);
  ctx.fillText(x.why, 72, 418 + lines.length * 118 - 40);
  // Four numbers on frosted tiles.
  const top = 900;
  const gap = 24;
  const tw = (SHARE_W - 144 - gap) / 2;
  const th = 150;
  x.figures.slice(0, 4).forEach((f, i) => {
    const tx = 72 + (i % 2) * (tw + gap);
    const ty = top + Math.floor(i / 2) * (th + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw, th, 30);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    fit(ctx, f.value, 850, 64, tw - 56);
    ctx.fillText(f.value, tx + 28, ty + 82);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `650 26px ${FONT}`;
    ctx.fillText(f.label, tx + 28, ty + 122);
  });
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `600 26px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('Made with Beluga · your agents, side by side', SHARE_W / 2, SHARE_H - 44);
  return c.toDataURL('image/png');
}
