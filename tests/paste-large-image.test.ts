import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, importImageFitting } from '../src/core/attachments.js';
import { decodeImage } from '../src/image/decode.js';
import { MAX_PASTED_IMAGE_BYTES } from '../src/shared/uploads.js';
import { extOf, imageRoute, uploadName } from '../packages/mac/src/chat/paste-image.js';

/** A big picture pasted in the box (BLG-110): how it travels, what's refused, and what Beluga keeps of an 18 MB, 12 MP PNG. */

const MB = 1024 * 1024;

describe('imageRoute', () => {
  it('uploads any picture up to the cap from a served page, as it is', () => {
    expect(imageRoute(18 * MB, true)).toEqual({ kind: 'upload' });
    expect(imageRoute(MAX_PASTED_IMAGE_BYTES, true)).toEqual({ kind: 'upload' });
  });

  it('sends a small picture as bytes from the app, and says why a big one can’t go that way', () => {
    expect(imageRoute(MAX_ATTACHMENT_BYTES, false)).toEqual({ kind: 'bytes' });
    const big = imageRoute(18 * MB, false);
    expect(big.kind).toBe('refuse');
    expect(big.kind === 'refuse' && big.reason).toMatch(/too big to send from the app \(18\.0 MB; up to 3\.7 MB\)/);
  });

  it('refuses an absurd picture anywhere, before anything is read', () => {
    for (const served of [true, false]) {
      const r = imageRoute(MAX_PASTED_IMAGE_BYTES + 1, served);
      expect(r.kind === 'refuse' && r.reason).toMatch(/too big to attach \(100\.0 MB; up to 100\.0 MB\)/);
    }
  });
});

describe('uploadName', () => {
  it('keeps a name that says it is a picture, and names one that does not', () => {
    expect(uploadName({ name: 'shot.PNG', type: 'image/png' })).toBe('shot.PNG');
    expect(uploadName({ name: '', type: 'image/png' })).toBe('image.png');
    expect(uploadName({ name: 'clipboard', type: 'image/jpeg' })).toBe('image.jpeg');
    expect(extOf('image/webp')).toBe('webp');
    expect(extOf('application/octet-stream')).toBe('png');
  });
});

describe('an 18 MB, 12 MP PNG kept by Beluga', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('fits what Claude takes, still recognisably the picture', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-big-paste-'));
    const [width, height] = [3024, 4032];
    const png = new PNG({ width, height });
    const noise = randomBytes(width * height * 4);
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 64 + (noise[i]! & 15);
      png.data[i + 1] = 96 + (noise[i + 1]! & 15);
      png.data[i + 2] = 128 + (noise[i + 2]! & 15);
      png.data[i + 3] = 255;
    }
    const src = path.join(dir, 'image.png');
    writeFileSync(src, PNG.sync.write(png, { colorType: 2 }));
    expect(statSync(src).size).toBeGreaterThan(16 * MB);

    const kept = await importImageFitting(src, path.join(dir, 'attachments'));
    expect(statSync(kept).size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    expect(statSync(src).size).toBeGreaterThan(16 * MB);
    const back = decodeImage(readFileSync(kept), kept, 4000);
    expect(back.height / back.width).toBeCloseTo(height / width, 2);
  }, 60_000);
});
