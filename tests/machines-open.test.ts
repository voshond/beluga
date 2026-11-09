import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editorHere, remoteEditorUrl, revealThere, revealThereLabel } from '../src/machines/open.js';
import { downloadThere, readPieceHere } from '../src/machines/uploads.js';
import { UPLOAD_PIECE } from '../src/shared/uploads.js';

/**
 * Open in Finder and editors, for a computer (BLG-794): VS Code or Cursor over Remote-SSH for a
 * computer added over SSH, and Download for a single file and Copy Path for a folder.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-open-'));
  dirs.push(d);
  return d;
};

describe('Open in Editor over Remote-SSH', () => {
  it('names the folder or file on the host, at a line', () => {
    expect(remoteEditorUrl('vscode', 'kayra@mini', '/home/kayra/code/bob-api')).toBe('vscode://vscode-remote/ssh-remote+kayra@mini/home/kayra/code/bob-api');
    expect(remoteEditorUrl('cursor', 'aws-dev', '/srv/my app/src/a.ts', 12)).toBe('cursor://vscode-remote/ssh-remote+aws-dev/srv/my%20app/src/a.ts:12');
  });

  it('names nothing it can’t open safely', () => {
    expect(remoteEditorUrl('vscode', '-oProxyCommand=evil', '/x')).toBeUndefined();
    expect(remoteEditorUrl('vscode', 'mini', 'relative/path')).toBeUndefined();
    expect(remoteEditorUrl('vscode', 'mini', '/a/../etc')).toBeUndefined();
    expect(remoteEditorUrl('vscode', 'mini host', '/a')).toBeUndefined();
  });

  it('picks Cursor when it’s your editor or the only one installed', () => {
    expect(editorHere({ VISUAL: 'cursor --wait' }, () => true)).toBe('cursor');
    expect(editorHere({ EDITOR: 'code -w' }, () => true)).toBe('vscode');
    expect(editorHere({}, (app) => app === 'cursor')).toBe('cursor');
    expect(editorHere({}, () => true)).toBe('vscode');
  });
});

describe('Show in Finder on a computer’s page', () => {
  it('is Download for a file and Copy Path for a folder', () => {
    expect([revealThere('file'), revealThereLabel('file')]).toEqual(['download', 'Download']);
    expect([revealThere('folder'), revealThereLabel('folder')]).toEqual(['copy', 'Copy Path']);
  });

  it('downloads a file there to this Mac a piece at a time, never overwriting one', async () => {
    const there = tmp();
    const here = path.join(tmp(), 'Downloads');
    const file = path.join(there, 'build.log');
    const bytes = Buffer.alloc(UPLOAD_PIECE * 2 + 99, 3);
    writeFileSync(file, bytes);
    const asked: number[] = [];
    const call = (method: string, args: readonly unknown[]) => {
      expect(method).toBe('machines.download.piece');
      asked.push(args[1] as number);
      return readPieceHere(args[0] as string, args[1] as number);
    };
    const first = await downloadThere(call, file, here);
    expect(first).toBe(path.join(here, 'build.log'));
    expect(readFileSync(first).equals(bytes)).toBe(true);
    expect(asked).toEqual([0, UPLOAD_PIECE, UPLOAD_PIECE * 2]);
    expect(await downloadThere(call, file, here)).toBe(path.join(here, 'build (1).log'));
  });

  it('refuses a secret, a folder and a relative path there, and leaves nothing half-done here', async () => {
    const there = tmp();
    const here = path.join(tmp(), 'Downloads');
    writeFileSync(path.join(there, '.env'), 'TOKEN=1');
    mkdirSync(path.join(there, 'src'));
    const call = (_m: string, args: readonly unknown[]) => readPieceHere(args[0] as string, args[1] as number);
    await expect(downloadThere(call, path.join(there, '.env'), here)).rejects.toThrow(/private/);
    await expect(downloadThere(call, path.join(there, 'src'), here)).rejects.toThrow(/Only a file/);
    await expect(readPieceHere('notes.txt', 0)).rejects.toThrow(/whole path/);
    expect(readdir(here)).toEqual([]);
  });
});

const readdir = (d: string): string[] => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
