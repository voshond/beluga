/** Files you send the computer Beluga runs on: from a browser (docs/web.md) or your app (BLG-793). Browser-safe. */

/** The largest file sent. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** Bytes per piece your app sends a computer (before base64). */
export const UPLOAD_PIECE = 512 * 1024;

/** Biggest image accepted (the Claude API takes up to 5 MB per image once base64-encoded, a third bigger). */
export const MAX_ATTACHMENT_BYTES = Math.floor(3.7 * 1024 * 1024);
/** Biggest picture a paste or drop takes (BLG-110): past it, a clear no rather than a window that chokes on it. */
export const MAX_PASTED_IMAGE_BYTES = 100 * 1024 * 1024;
