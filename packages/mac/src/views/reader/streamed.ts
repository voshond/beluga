import { useCallback, useState } from 'react';
import { type Location, type ViewerDomain, clean } from '@beluga/core/store.js';
import { FIRST_RANGE, MAX_STREAM_BYTES, type RangeOptions, type TextRange } from '@beluga/shared/text-range.js';
import { isVisualFile } from './reader-model.js';
import { loadReader } from './reader-lazy.js';

/**
 * Files read in pieces (BLG-791): the first screen first, the rest as you scroll, and the file under
 * the pointer read ahead, so on one of your computers a file opens as fast as one on this Mac. The
 * app's daemon keeps what a computer sent (src/machines/files.ts); here, only the first pieces read
 * ahead, a few, in memory.
 */

export interface RangeApi {
  readonly files: { readRange(at: Location, range: RangeOptions): Promise<TextRange> };
}

/** The piece asked for each time the reader nears the end of what it has. */
export const NEXT_RANGE = 256 * 1024;
/** First pieces kept here (read ahead or opened). */
const KEPT = 24;
/** How long the pointer rests on a file before it's read ahead. */
export const AHEAD_MS = 60;

const keyOf = (at: Location): string => `${at.owner}\0${at.share}\0${at.path}`;
/** In use order: the first is the oldest. */
const firsts = new Map<string, TextRange>();
const asking = new Map<string, Promise<TextRange | undefined>>();

function keep(key: string, piece: TextRange): void {
  firsts.delete(key);
  firsts.set(key, piece);
  for (const old of firsts.keys()) {
    if (firsts.size <= KEPT) break;
    firsts.delete(old);
  }
}

/** A file's first piece, when it was read ahead or opened a moment ago. */
export const peekFirst = (at: Location): TextRange | undefined => firsts.get(keyOf(at));

/** A file's first piece. `cache`: one read moments ago will do (it opened from a read-ahead). */
export function readFirst(api: RangeApi, at: Location, cache: boolean): Promise<TextRange> {
  return api.files.readRange({ owner: at.owner, share: at.share, path: at.path }, { offset: 0, length: FIRST_RANGE, cache }).then((piece) => {
    keep(keyOf(at), piece);
    return piece;
  });
}

/** Read a file's first piece ahead of a click (pictures and PDFs are read as themselves, not here). */
export function readAhead(api: RangeApi, at: Location): void {
  const key = keyOf(at);
  // The reader's own code comes ahead too: the click draws, never waits for a chunk to load.
  void loadReader();
  if (isVisualFile(at.path) || asking.has(key)) return;
  const p = readFirst(api, at, true)
    .catch(() => undefined)
    .finally(() => asking.delete(key));
  asking.set(key, p);
}

let resting: ReturnType<typeof setTimeout> | undefined;

/** A row's pointer handlers: the file under the pointer is read ahead once it rests there. */
export function aheadOnHover(api: RangeApi, at: () => Location | undefined): { onMouseEnter: () => void; onMouseLeave: () => void } {
  return {
    onMouseEnter: () => {
      clearTimeout(resting);
      resting = setTimeout(() => {
        const where = at();
        if (where) readAhead(api, where);
      }, AHEAD_MS);
    },
    onMouseLeave: () => clearTimeout(resting),
  };
}

export interface Rest {
  /** What came after the first piece so far. */
  readonly text: string;
  /** Ask for the next piece (none: it's all here, one is on its way, or it's too long to stream). */
  readonly more?: () => void;
  readonly loading: boolean;
  /** It stopped at MAX_STREAM_BYTES: the rest of the file isn't shown. */
  readonly capped: boolean;
  readonly error?: string;
}

interface RestState {
  readonly base: string;
  readonly text: string;
  readonly next?: number;
  readonly loading: boolean;
  readonly error?: string;
}

/** The rest of a file opened by its first piece, a piece at a time as the reader asks. */
export function useRest(api: RangeApi, viewer: Pick<ViewerDomain, 'owner' | 'share' | 'path' | 'content' | 'next'>): Rest {
  const base = `${keyOf(viewer)}\0${viewer.next ?? ''}\0${viewer.content.length}`;
  const [state, setState] = useState<RestState>({ base, text: '', ...(viewer.next !== undefined ? { next: viewer.next } : {}), loading: false });
  const cur: RestState = state.base === base ? state : { base, text: '', ...(viewer.next !== undefined ? { next: viewer.next } : {}), loading: false };
  const { next } = cur;
  const can = next !== undefined && !cur.loading && !cur.error && next < MAX_STREAM_BYTES;
  const more = useCallback(() => {
    if (next === undefined) return;
    setState({ ...cur, loading: true });
    api.files.readRange({ owner: viewer.owner, share: viewer.share, path: viewer.path }, { offset: next, length: NEXT_RANGE, cache: true }).then(
      (piece) => setState((s) => (s.base !== base ? s : { base, text: s.text + clean(piece.content), ...(piece.next !== undefined ? { next: piece.next } : {}), loading: false })),
      (err: unknown) => setState((s) => (s.base !== base ? s : { ...s, loading: false, error: err instanceof Error ? err.message : String(err) })),
    );
  }, [base, next]);
  return {
    text: cur.text,
    ...(can ? { more } : {}),
    loading: cur.loading,
    capped: next !== undefined && next >= MAX_STREAM_BYTES,
    ...(cur.error ? { error: cur.error } : {}),
  };
}
