import { MAX_ATTACHMENT_BYTES, MAX_PASTED_IMAGE_BYTES } from '../../../../src/shared/uploads.js';
import { sizeWords } from './pasted-text.js';

/**
 * How a pasted or dropped picture reaches Beluga (BLG-110). A page the server sent (the thin
 * client, a browser) uploads the file as it is, in binary, and Beluga keeps it from there as it
 * keeps a pasted path; the app sends its bytes in one message, which only a picture Claude takes
 * as it is fits in. Past MAX_PASTED_IMAGE_BYTES, neither: a clear no before anything is read.
 */
export type ImageRoute = { readonly kind: 'upload' } | { readonly kind: 'bytes' } | { readonly kind: 'refuse'; readonly reason: string };

export const imageRoute = (size: number, served: boolean): ImageRoute => {
  if (size > MAX_PASTED_IMAGE_BYTES) return { kind: 'refuse', reason: `it's too big to attach (${sizeWords(size)}; up to ${sizeWords(MAX_PASTED_IMAGE_BYTES)})` };
  if (served) return { kind: 'upload' };
  if (size > MAX_ATTACHMENT_BYTES) return { kind: 'refuse', reason: `it's too big to send from the app (${sizeWords(size)}; up to ${sizeWords(MAX_ATTACHMENT_BYTES)}). Save it and paste its path instead` };
  return { kind: 'bytes' };
};

export type ImageExt = 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp';

export const extOf = (type: string): ImageExt => (/image\/(png|jpe?g|gif|webp)/.exec(type)?.[1] ?? 'png') as ImageExt;

/** The name an upload goes by: its own when it says what it is (Beluga only keeps images by their extension). */
export const uploadName = (file: { readonly name: string; readonly type: string }): string => (/\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name : `image.${extOf(file.type)}`);
