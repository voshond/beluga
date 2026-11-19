/**
 * Which picture a paste attaches, when the clipboard offers it several ways (BLG-109). One type is
 * taken, in this order: a GIF (only an original is ever one, and it stays animated), then PNG
 * (lossless), then WebP, then JPEG (both often a copy the source made from its pixels).
 */
export const PASTE_IMAGE_ORDER = ['image/gif', 'image/png', 'image/webp', 'image/jpeg'] as const;

export type PasteImageType = (typeof PASTE_IMAGE_ORDER)[number];

const rank = (type: string): number => {
  const at = PASTE_IMAGE_ORDER.indexOf(type.toLowerCase() as PasteImageType);
  return at < 0 ? PASTE_IMAGE_ORDER.length : at;
};

export const bestImageType = (offered: readonly string[]): PasteImageType | undefined =>
  [...offered].filter((t) => rank(t) < PASTE_IMAGE_ORDER.length).sort((a, b) => rank(a) - rank(b))[0]?.toLowerCase() as PasteImageType | undefined;

export type PastedImage = { readonly name: string; readonly type: string; readonly size: number };

/** What a web view names a picture straight off the clipboard (a file keeps its own name). */
const rendition = (f: PastedImage): boolean => !f.name || /^image\.\w+$/i.test(f.name);

/**
 * The pictures a paste attaches. An empty one is left out (WebKitGTK names any clipboard image
 * "image.png" and has no bytes for it unless it was a PNG). The clipboard's own picture offered
 * several ways (each unnamed, each of a different type) is one picture: only the best goes.
 */
export const pickPastedImages = <T extends PastedImage>(files: readonly T[]): T[] => {
  const kept = files.filter((f) => f.size > 0);
  const offered = kept.filter(rendition);
  if (offered.length < 2 || new Set(offered.map((f) => f.type.toLowerCase())).size < offered.length) return kept;
  const best = bestImageType(offered.map((f) => f.type));
  const chosen = offered.find((f) => f.type.toLowerCase() === best) ?? offered[0]!;
  return kept.filter((f) => !rendition(f) || f === chosen);
};
