import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { type AppState, type Location, type ViewerState, fileKey } from '@beluga/core/store.js';
import type { ChangedFile as Change } from '@beluga/workspaces/git.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { useApi, useApp } from '../lib/beluga.js';
import type { DocVariant } from '../components/markdown/MarkdownDoc.js';
import { hasRenderedLook, isVisualFile } from './reader/reader-model.js';
import { peekFirst, readFirst } from './reader/streamed.js';
import r from './reader/reader.module.css';
import { ReaderContent } from './reader/reader-lazy.js';

/**
 * A changed file as itself, next to its diff: Markdown formatted, web pages drawn, pictures and PDFs as they look,
 * code as it is now. Read on its own, so the Files tab's open file stays where it is.
 */

/** The reader in its own chunk (views/reader/reader-lazy.tsx): fetched early, drawn at once once it's here (BLG-853), giving up on a stalled fetch instead of waiting (#370). */
const FileContent = ReaderContent;

/** How a changed file can be looked at: its diff, or the file (a picture or a PDF only as itself). */
export type ChangeLook = 'diff' | 'file';

/** A picture or a PDF has no text to compare: it shows as itself. */
export const onlyAsFile = (path: string): boolean => isVisualFile(path);

/** A file that's gone has nothing to show but its diff. */
export const canShowFile = (f: Pick<Change, 'state'>): boolean => f.state !== 'deleted';

/** The name of the "as itself" look: formatted Markdown is a preview, anything else the file. */
export const fileLookLabel = (path: string): string => (hasRenderedLook(path) ? 'Preview' : 'File');

/** Where a changed file is, for the workspace (or the one shared with you) on screen. */
export function changeLocation(state: Pick<AppState, 'view' | 'selfId' | 'shared'>, path: string): Location | undefined {
  const view = state.view;
  if (view.kind === 'workspace') return { owner: state.selfId, share: shareNameOf(view.id), path };
  if (view.kind === 'shared') {
    const w = state.shared.find((x) => x.id === view.id && x.owner === view.owner);
    return w ? { owner: w.owner, share: w.share, path } : undefined;
  }
  return undefined;
}

/** Where a changed file is, kept the same object while nothing about it changes. */
export function useChangeLocation(path: string | undefined): Location | undefined {
  const view = useApp((st) => st.view);
  const selfId = useApp((st) => st.selfId);
  const shared = useApp((st) => st.shared);
  return useMemo(() => (path ? changeLocation({ view, selfId, shared }, path) : undefined), [view, selfId, shared, path]);
}

interface Text {
  readonly content?: string;
  /** A big file: where the rest starts (the reader streams it as you scroll), and its size. */
  readonly next?: number;
  readonly total?: number;
  readonly error?: string;
}

/**
 * The file's first piece (BLG-791), read again whenever the changes are (Claude edited it, a
 * commit) or it's written. Opening, one read ahead under the pointer shows at once and will do.
 */
function useText(at: Location, skip: boolean, version: unknown, written: number | undefined): Text {
  const api = useApi();
  const key = `${at.owner}\0${at.share}\0${at.path}`;
  const [state, setState] = useState<Text & { key: string }>();
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (skip) return;
    let alive = true;
    // Its first read may come from the read-ahead; a read after a change asks the file again.
    const first = opened.current !== key;
    opened.current = key;
    readFirst(api, at, first).then(
      (piece) => alive && setState({ key, content: piece.content, ...(piece.next !== undefined ? { next: piece.next, total: piece.total } : {}) }),
      (err: unknown) => alive && setState({ key, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [key, version, written, skip]);
  if (state?.key === key) return state;
  const ahead = skip ? undefined : peekFirst(at);
  return ahead ? { content: ahead.content, ...(ahead.next !== undefined ? { next: ahead.next, total: ahead.total } : {}) } : {};
}

export function ChangedFileView({ at, variant, wrap = true, version: own }: { at: Location; variant: DocVariant; wrap?: boolean; version?: string | number }) {
  const visual = isVisualFile(at.path);
  // Read again when the changes are (or, given one, its own version: when it was last written), and when Beluga sees it written.
  const reviewed = useApp((st) => st.review?.data);
  const written = useApp((st) => st.written[fileKey(at)]);
  const text = useText(at, visual, own ?? reviewed, written);
  const viewer: ViewerState = {
    ...at,
    content: text.content ?? '',
    truncated: false,
    ...(text.next !== undefined ? { next: text.next, total: text.total } : {}),
    loading: !visual && text.content === undefined && !text.error,
    ...(text.error ? { error: text.error } : {}),
    scroll: 0,
  };
  return (
    <Suspense fallback={<div className={r.opening}>Opening…</div>}>
      <FileContent viewer={viewer} variant={variant} mode="rendered" onMode={() => undefined} wrap={wrap} version={own} />
    </Suspense>
  );
}
