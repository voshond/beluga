import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Mac app's alias for the core; only its scheme is used here.
vi.mock('@beluga/core/attachment-share.js', () => ({ ATTACHMENT_SCHEME: 'beluga-attachment://' }));

/** A fake core: every image is a tiny PNG; counts the reads. `versions`: a file's size and time (missing: it can't be told). */
const reads: string[] = [];
const versions = new Map<string, { size: number; mtime: number }>();
const api = {
  session: { localLocation: async (p: string) => ({ owner: '', share: '', path: p }) },
  files: {
    readImageFile: async (at: { path: string }) => (reads.push(at.path), { data: btoa('png'), mediaType: 'image/png' }),
    version: async (at: { path: string }) => {
      const v = versions.get(at.path);
      if (!v) throw new Error('ENOENT');
      return v;
    },
  },
  attachments: { read: async () => ({ data: btoa('png'), mime: 'image/png' }) },
} as never;
/** Through a variable: the root typecheck can't follow the Mac app's @beluga paths (its own tsc checks the file). */
const MODULE = '../packages/mac/src/chat/images.js';
type Images = { loadImage: (api: never, image: object, size: 'thumb' | 'full') => Promise<string>; holdImage: (api: never, image: object, size: 'thumb' | 'full') => { url: Promise<string>; release: () => void } };
const images = (): Promise<Images> => import(MODULE) as Promise<Images>;
const img = (n: number) => ({ href: `local:/shots/${n}.png`, owner: '', file: '', local: `/shots/${n}.png` });

let made = 0;
const revoked = new Set<string>();

beforeEach(() => {
  made = 0;
  revoked.clear();
  reads.length = 0;
  versions.clear();
  vi.resetModules();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++made}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.add(u));
  // No decoder here: shrink keeps the picture as it is.
  vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('no decoder')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chat images are let go once the window has enough (BLG-367)', () => {
  it('keeps a picture once read, and reads it again only after it was let go', async () => {
    const { loadImage } = await images();
    const a = await loadImage(api, img(1), 'thumb');
    expect(await loadImage(api, img(1), 'thumb')).toBe(a);
    expect(reads).toEqual(['/shots/1.png']);
  });

  it('lets the oldest full-size pictures go past a few, but never one on screen', async () => {
    const { holdImage, loadImage } = await images();
    const shown = holdImage(api, img(0), 'full');
    const first = await shown.url;
    const urls = [];
    for (let n = 1; n <= 10; n++) urls.push(await loadImage(api, img(n), 'full'));
    expect(revoked.has(first)).toBe(false);
    expect(revoked.size).toBe(6);
    expect(revoked.has(urls[0]!)).toBe(true);
    expect(revoked.has(urls[9]!)).toBe(false);
    // Off screen: it goes too, the next time the window has too many.
    shown.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(revoked.has(first)).toBe(true);
  });

  it('keeps thumbnails and full pictures apart: opening the lightbox reads the full one', async () => {
    const { loadImage } = await images();
    const thumb = await loadImage(api, img(1), 'thumb');
    const full = await loadImage(api, img(1), 'full');
    expect(full).not.toBe(thumb);
    expect(reads).toHaveLength(2);
  });
});

describe('a picture rewritten under the same name shows the new one (BLG-749)', () => {
  it('reads the file again once its size or time changed, and only then', async () => {
    const { loadImage } = await images();
    versions.set('/shots/1.png', { size: 100, mtime: 1000 });
    const first = await loadImage(api, img(1), 'thumb');
    // Unchanged: shown again from what was kept, not read again.
    expect(await loadImage(api, img(1), 'thumb')).toBe(first);
    expect(reads).toEqual(['/shots/1.png']);
    // Re-taken (an e2e run's screenshot): the next answer showing that path reads it again.
    versions.set('/shots/1.png', { size: 120, mtime: 2000 });
    const second = await loadImage(api, img(1), 'thumb');
    expect(second).not.toBe(first);
    expect(reads).toEqual(['/shots/1.png', '/shots/1.png']);
    expect(await loadImage(api, img(1), 'thumb')).toBe(second);
    expect(reads).toHaveLength(2);
  });

  it('a same-size rewrite counts too (only the time moved)', async () => {
    const { loadImage } = await images();
    versions.set('/shots/1.png', { size: 100, mtime: 1000 });
    const first = await loadImage(api, img(1), 'thumb');
    versions.set('/shots/1.png', { size: 100, mtime: 1001 });
    expect(await loadImage(api, img(1), 'thumb')).not.toBe(first);
  });

  it('the earlier answer keeps its picture while it is on screen (never let go under it)', async () => {
    const { holdImage, loadImage } = await images();
    versions.set('/shots/1.png', { size: 100, mtime: 1000 });
    const earlier = holdImage(api, img(1), 'full');
    const old = await earlier.url;
    versions.set('/shots/1.png', { size: 120, mtime: 2000 });
    const now = await loadImage(api, img(1), 'full');
    expect(now).not.toBe(old);
    // Enough other pictures to push past what the window keeps: the one on screen stays.
    for (let n = 2; n <= 10; n++) await loadImage(api, img(n), 'full');
    expect(revoked.has(old)).toBe(false);
    earlier.release();
  });

  it('falls back to the path alone when the version can’t be told', async () => {
    const { loadImage } = await images();
    const first = await loadImage(api, img(1), 'thumb');
    expect(await loadImage(api, img(1), 'thumb')).toBe(first);
    expect(reads).toHaveLength(1);
  });
});
