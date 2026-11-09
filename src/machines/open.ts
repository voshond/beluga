/**
 * The buttons that open a file or folder on this Mac, for one on one of your computers (BLG-794).
 * Finder and this Mac's editor can't reach a headless computer, so a remote page does instead:
 * Open in Editor opens it in VS Code or Cursor over Remote-SSH when the computer was added over
 * SSH; Show in Finder becomes Download for a single file (it comes to this Mac) and Copy Path for a
 * folder. Go to Code needs nothing here: it opens the streamed file in the reader. Browser-safe.
 */

export type RemoteEditor = 'vscode' | 'cursor';

/** An ssh host as Remote-SSH names it: a Host of your ssh config, or user@host. */
const HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/;

/**
 * VS Code's (or Cursor's) link to a folder or file on `host` over Remote-SSH
 * (vscode://vscode-remote/ssh-remote+host/path), a file at `line`; undefined for what it can't name.
 */
export function remoteEditorUrl(editor: RemoteEditor, host: string, absPath: string, line?: number): string | undefined {
  if (!HOST.test(host) || !absPath.startsWith('/') || absPath.split('/').includes('..')) return undefined;
  const path = absPath.split('/').map(encodeURIComponent).join('/');
  return `${editor}://vscode-remote/ssh-remote+${host}${path}${line && line > 0 ? `:${Math.floor(line)}` : ''}`;
}

/** What a remote page does for Show in Finder: a file comes down, a folder's path is copied. */
export const revealThere = (kind: 'file' | 'folder'): 'download' | 'copy' => (kind === 'file' ? 'download' : 'copy');

/** The button's words for it. */
export const revealThereLabel = (kind: 'file' | 'folder'): string => (kind === 'file' ? 'Download' : 'Copy Path');

/**
 * Which editor opens a remote folder: Cursor when it's your editor ($VISUAL / $EDITOR) or the only
 * one of the two installed, else VS Code.
 */
export function editorHere(env: Readonly<Record<string, string | undefined>>, installed: (app: RemoteEditor) => boolean): RemoteEditor {
  const named = `${env.VISUAL ?? ''} ${env.EDITOR ?? ''}`;
  if (/\bcursor\b/i.test(named)) return 'cursor';
  if (/\bcode\b/i.test(named)) return 'vscode';
  return installed('cursor') && !installed('vscode') ? 'cursor' : 'vscode';
}
