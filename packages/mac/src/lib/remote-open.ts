import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { remoteEditorUrl, revealThere, revealThereLabel } from '@beluga/machines/open.js';
import { joinPath } from '@beluga/shared/os-path.js';
import { useMachine } from './beluga.js';
import { revealLabel } from './os-words.js';
import { currentMachines } from '../machines/use-machines.js';

/**
 * Open in Finder and editors on a computer's page (BLG-794, src/machines/open.ts): what names a
 * path there does the right thing here. Open in Editor opens it in VS Code or Cursor over
 * Remote-SSH when the computer was added over SSH; Show in Finder downloads a single file to this
 * Mac (and shows it in Finder) or copies a folder's path. On this Mac's own pages, nothing changes.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface There {
  readonly id: string;
  readonly home: SocketClient;
  readonly name: string;
  /** The ssh host it was added over. */
  readonly sshHost?: string;
}

async function where(client: SocketClient): Promise<There | undefined> {
  const { machineOfClient } = await import('../machines/pane-clients.js');
  const on = machineOfClient(client);
  if (!on) return undefined;
  const { currentMachines } = await import('../machines/use-machines.js');
  const view = currentMachines().find((m) => m.id === on.id);
  return { ...on, name: view?.name ?? 'your computer', ...(view?.ssh ? { sshHost: view.ssh } : {}) };
}

const say = (client: SocketClient, text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void => client.store.dispatch({ type: 'toast', text, level });

/**
 * Show `path` (on the computer `client` is a screen of) in Finder, or open it in your editor (`how`).
 * → false on this Mac's own screen: the caller does it the Mac way.
 */
export async function openThere(client: SocketClient, path: string, how: 'reveal' | 'open', line?: number): Promise<boolean> {
  const on = await where(client);
  if (!on) return false;
  try {
    if (how === 'open' && on.sshHost) {
      const editor = await on.home.call('machines.editor');
      const url = remoteEditorUrl(editor, on.sshHost, path, line);
      if (url) {
        await openUrl(url);
        return true;
      }
    }
    const [info] = await client.api.local.statFiles([path]);
    if (!info || info.kind === 'missing') {
      say(on.home, `Can’t find ${path} on ${on.name}`, 'warn');
      return true;
    }
    if (revealThere(info.kind) === 'download') {
      say(on.home, `Downloading ${info.name} from ${on.name}…`);
      const saved = await on.home.call('machines.download.fetch', on.id, path);
      say(on.home, `Downloaded ${info.name} to ${saved}`, 'success');
      const { revealInFinder } = await import('./files.js');
      await revealInFinder(on.home, saved);
      return true;
    }
    const { copyText } = await import('./copy.js');
    await copyText(path);
    say(on.home, `Copied the path on ${on.name}: ${path}`, 'success');
  } catch (err) {
    say(on.home, `Couldn’t open it from ${on.name}: ${errorText(err)}`, 'error');
  }
  return true;
}

const worktreeOf = (client: SocketClient, wsId: string) =>
  client.store
    .getState()
    .projects.flatMap((p) => p.workspaces)
    .find((w) => w.id === wsId);

/** A worktree's folder in Finder: on a computer's page, its path copied. */
export async function showWorktreeFolder(client: SocketClient, wsId: string): Promise<void> {
  const ws = worktreeOf(client, wsId);
  if (ws && (await openThere(client, ws.path, 'reveal'))) return;
  await client.api.workspaces.openInFinder(wsId);
}

/**
 * A worktree's file in your editor at a line: on a computer added over SSH, over Remote-SSH; on
 * one that wasn't, in the reader (Go to Code: the streamed file, at its line).
 */
export async function openCodeThere(client: SocketClient, wsId: string, file: string, line?: number): Promise<void> {
  const on = await where(client);
  if (!on) return void (await client.api.workbench.openCode(wsId, file, line));
  const ws = worktreeOf(client, wsId);
  if (on.sshHost && ws && (await openThere(client, joinPath(ws.path, file.replace(/^\.\//, '')), 'open', line))) return;
  const { goToCode } = await import('./go-to-code.js');
  await goToCode(client, wsId, file, line);
}

/**
 * Open a folder (local.openFolder): on a computer's page, in your editor over Remote-SSH when it
 * was added over SSH, else its path copied. Never a folder opened over there.
 */
export async function openFolderThere(client: SocketClient, dir: string): Promise<void> {
  if (await openThere(client, dir, 'open')) return;
  await client.api.local.openFolder(dir);
}

/** The words of a Show in Finder button for a folder: on a computer's page, Copy Path. */
export function useRevealLabel(what?: string): string {
  return useMachine() ? revealThereLabel('folder') : revealLabel(what);
}

/**
 * The words of a button that opens a folder (openFolderThere): `open` here; on a computer's page,
 * in your editor when it was added over SSH, else `copy`.
 */
export function useOpenFolderLabel(open: string, copy: string): string {
  const machine = useMachine();
  if (!machine) return open;
  return currentMachines().find((m) => m.id === machine)?.ssh ? `${open} in Your Editor` : copy;
}

/** The same for a single file: on a computer's page, Download (it comes to this Mac). */
export function useRevealFileLabel(what?: string): string {
  return useMachine() ? (what ? `Download ${what}` : revealThereLabel('file')) : revealLabel(what);
}

/** An editor's own link (vscode://, cursor://): the system hands it to the editor. */
async function openUrl(url: string): Promise<void> {
  const { inApp } = await import('./boot.js');
  if (inApp()) {
    const { openUrl: open } = await import('@tauri-apps/plugin-opener');
    await open(url);
  } else window.open(url, '_blank', 'noopener');
}
