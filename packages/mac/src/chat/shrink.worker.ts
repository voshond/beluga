/**
 * A picture made smaller in its own thread (BLG-110): decoding a 12-megapixel paste and drawing
 * it small takes long enough to freeze the window, so images.ts asks here first.
 */

export interface ShrinkAsk {
  readonly id: number;
  readonly blob: Blob;
  readonly px: number;
}

/** `blob`: the smaller copy, or none when the picture is already that small. `error`: it couldn't be read. */
export interface ShrinkAnswer {
  readonly id: number;
  readonly blob?: Blob;
  readonly error?: string;
}

const shrinkHere = async ({ blob, px }: ShrinkAsk): Promise<Blob | undefined> => {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = px / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return undefined;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const g = canvas.getContext('2d');
    if (!g) throw new Error('No canvas to draw on');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // A photo stays a photo (small as JPEG); a screenshot or anything see-through stays PNG.
    return await canvas.convertToBlob({ type: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.9 });
  } finally {
    bitmap.close();
  }
};

addEventListener('message', (e: MessageEvent<ShrinkAsk>) => {
  const ask = e.data;
  shrinkHere(ask).then(
    (blob) => postMessage({ id: ask.id, blob } satisfies ShrinkAnswer),
    (err: Error) => postMessage({ id: ask.id, error: err?.message ?? String(err) } satisfies ShrinkAnswer),
  );
});
