import { bestImageType, pickPastedImages } from '../chat/paste-images-model.js';
import { appInvoke, inShell } from './boot-mode.js';

/**
 * The clipboard's picture as the app reads it, its own bytes and type (BLG-109): WebKitGTK hands
 * the page only a PNG, so a JPEG, WebP or GIF would paste empty. Undefined where the app has no
 * such read (a browser, macOS and Windows, whose web views hand over the real file).
 */
const nativeClipboardImage = async (): Promise<File | undefined> => {
  if (!inShell()) return undefined;
  const offered = await appInvoke<string[]>('clipboard_image_types').catch(() => []);
  const type = bestImageType(offered);
  if (!type) return undefined;
  const bytes = await appInvoke<ArrayBuffer>('clipboard_image', { mime: type }).catch(() => undefined);
  if (!bytes || bytes.byteLength === 0) return undefined;
  return new File([bytes], `image.${type.slice('image/'.length)}`, { type });
};

/** A paste's pictures: the app's read of the clipboard where it has one, else the web view's. */
export const pastedImages = async (offered: readonly File[]): Promise<File[]> => {
  const native = await nativeClipboardImage();
  return native ? [native] : pickPastedImages(offered);
};
