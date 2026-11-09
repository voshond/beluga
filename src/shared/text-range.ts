/**
 * A file read in pieces (BLG-791): the first screen first, the rest as you scroll, so a big file on
 * one of your computers opens without waiting for all of it. Browser-safe.
 */

/** The first piece of a file too big to read whole: a few screens of text. */
export const FIRST_RANGE = 128 * 1024;
/** The most one piece may ask for. */
export const MAX_RANGE = 1024 * 1024;
/** How far scrolling streams a file before it says the rest is too long to show here. */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;

/** One piece of a file's text (files.readRange). */
export interface TextRange {
  readonly content: string;
  /** The byte it starts at. */
  readonly offset: number;
  /** Where the next piece starts; none: this piece reaches the end. */
  readonly next?: number;
  /** The file's size in bytes. */
  readonly total: number;
  /** When it last changed (ms): a piece of another version isn't joined to this one. */
  readonly mtime: number;
  /** Not text: nothing to show as text. */
  readonly binary?: true;
  /** Kept on this Mac from earlier; the computer can't be reached now. */
  readonly stale?: true;
}

export interface RangeOptions {
  readonly offset: number;
  readonly length: number;
  /** A copy fetched moments ago will do (a prefetch, the next piece): the app answers it from its cache. */
  readonly cache?: boolean;
}

/**
 * Where a piece of `bytes` ends as text: after its last line end when one is in its second half,
 * else at the last whole UTF-8 character, so no piece splits a character (or, mostly, a line).
 * At the end of the file, all of it.
 */
export function textEnd(bytes: Uint8Array, atEof: boolean): number {
  if (atEof || bytes.length === 0) return bytes.length;
  const nl = bytes.lastIndexOf(0x0a);
  if (nl >= 0 && nl + 1 >= bytes.length / 2) return nl + 1;
  let lead = bytes.length - 1;
  // Back over continuation bytes (10xxxxxx) to the character's first byte.
  while (lead > 0 && bytes.length - lead < 4 && (bytes[lead]! & 0xc0) === 0x80) lead -= 1;
  const first = bytes[lead]!;
  if (first < 0xc0) return bytes.length;
  const need = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : 2;
  const end = bytes.length - lead < need ? lead : bytes.length;
  return end > 0 ? end : bytes.length;
}
