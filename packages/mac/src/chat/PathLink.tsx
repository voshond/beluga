import type { ReactNode } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { shareNameOf } from '@beluga/shared/share-names.js';
import { baseName, sepOf } from '@beluga/shared/os-path.js';
import type { PathRef } from '@beluga/shared/render/path-refs.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { useActions } from '../lib/actions.js';
import { useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { localPathOf, revealInFinder } from '../lib/files.js';
import { goToCode } from '../lib/go-to-code.js';
import { revealLabel, thisComputer } from '../lib/os-words.js';
import s from './chat.module.css';

/** The worktree a relative path is in: the one on screen. */
const worktreeOf = (state: AppState): string | undefined => (state.view.kind === 'workspace' ? state.view.id : undefined);

/** Where a path is on this Mac: a relative one in the worktree on screen, "~" left for the daemon to expand. */
function fullPath(state: AppState, ref: PathRef): string | undefined {
  if (!ref.relative) return ref.path;
  const ws = worktreeOf(state);
  return ws ? localPathOf(state, { owner: state.selfId, share: shareNameOf(ws), path: ref.path.replace(/^\.\//, '').replace(/\/+$/, '') }) : undefined;
}

/** A file's place in the worktree on screen, when it's in it. */
function inWorktree(state: AppState, file: string): { ws: string; path: string } | undefined {
  const ws = worktreeOf(state);
  const root = ws ? localPathOf(state, { owner: state.selfId, share: shareNameOf(ws), path: '' })?.replace(/[\\/]+$/, '') : undefined;
  return ws && root && file.startsWith(root + sepOf(root)) ? { ws, path: file.slice(root.length + 1) } : undefined;
}

/** What the path is on this Mac now (a file, a folder, or nothing), with "~" expanded. */
async function lookUp(client: SocketClient, ref: PathRef): Promise<{ path: string; kind: 'file' | 'folder' } | undefined> {
  const at = fullPath(client.store.getState(), ref);
  if (!at) return undefined;
  const [info] = await client.api.local.statFiles([at]);
  return info && info.kind !== 'missing' ? { path: info.path, kind: info.kind } : undefined;
}

/**
 * A file or folder Claude named in the chat (shared/render/path-refs.ts), as a link: a file opens
 * in the viewer (at its line), a folder in Files. Right-click to show it in Finder or copy its path.
 */
export function PathLink({ pathRef: ref, children }: { pathRef: PathRef; children: ReactNode }) {
  const { client } = useBeluga();
  const actions = useActions();
  const looksLikeFolder = ref.dir || !/\.[^./\\]+$/.test(baseName(ref.path));
  const missing = (): void => client.store.dispatch({ type: 'toast', text: `Can’t find ${ref.path} on ${thisComputer()}`, level: 'warn' });
  const open = async (): Promise<void> => {
    const found = await lookUp(client, ref);
    if (!found) return missing();
    // A file of this worktree (however it was written): straight to it, at its line (Esc goes back to the chat).
    const inside = found.kind === 'file' ? inWorktree(client.store.getState(), found.path) : undefined;
    if (inside) return goToCode(client, inside.ws, inside.path, ref.line);
    actions.openLink({ kind: 'local', path: found.path, dir: found.kind === 'folder', ...(ref.line ? { line: ref.line } : {}) });
  };
  const items = (): readonly ActionItem[] => [
    { label: looksLikeFolder ? 'Open Folder' : 'Open', icon: looksLikeFolder ? 'folder' : 'file', onSelect: () => void open() },
    { label: revealLabel(), onSelect: () => void lookUp(client, ref).then((found) => (found ? revealInFinder(client, found.path) : missing())) },
    {
      label: 'Copy Path',
      icon: 'copy',
      separate: true,
      onSelect: () =>
        void lookUp(client, ref)
          .then((found) => copyText(found?.path ?? ref.path))
          .then(() => client.store.dispatch({ type: 'toast', text: 'Copied the path', level: 'success' })),
    },
  ];
  return (
    <ActionsContext items={items}>
      <a
        href={ref.path}
        className={s.pathLink}
        title={ref.line ? `${ref.path}, line ${ref.line}` : ref.path}
        onClick={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <Icon name={looksLikeFolder ? 'folder' : 'file'} size={11} />
        {children}
      </a>
    </ActionsContext>
  );
}
