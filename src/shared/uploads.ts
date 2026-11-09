/** Files you send the computer Beluga runs on: from a browser (docs/web.md) or your app (BLG-793). Browser-safe. */

/** The largest file sent. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** Bytes per piece your app sends a computer (before base64). */
export const UPLOAD_PIECE = 512 * 1024;
