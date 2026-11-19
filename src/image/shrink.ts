// A picture made smaller without the Mac's sips: for Windows and Linux. Reads what decode.ts
// does (PNG, JPEG, GIF's first frame, SVG); anything else fails, and the caller does without.
import { readFile, writeFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { Bitmap } from './bitmap.js';
import { decodeImageAsync } from './decode-async.js';

/** JPEG keeps no transparency: see-through parts go on white, as a viewer shows them. */
export function onWhite(bmp: Bitmap): Bitmap {
  const data = new Uint8Array(bmp.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = (bmp.data[i + 3] ?? 255) / 255;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round((bmp.data[i + c] ?? 0) * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
  return { width: bmp.width, height: bmp.height, data };
}

/** The bytes of `bmp` as a JPEG (quality 1-100) or a PNG (its transparency kept). */
export function encodeImage(bmp: Bitmap, format: 'jpeg' | 'png', quality = 80): Buffer {
  if (format === 'jpeg') return jpeg.encode({ data: Buffer.from(onWhite(bmp).data), width: bmp.width, height: bmp.height }, quality).data;
  const png = new PNG({ width: bmp.width, height: bmp.height });
  png.data = Buffer.from(bmp.data);
  return PNG.sync.write(png);
}

/** `src` at most `side` pixels on its longest side, written to `dest` as a JPEG or PNG. Throws when it can't be read. */
export async function shrinkImageFile(src: string, dest: string, side: number, format: 'jpeg' | 'png', quality = 80): Promise<void> {
  const bmp = await decodeImageAsync(await readFile(src), src, side);
  await writeFile(dest, encodeImage(bmp, format, quality));
}
