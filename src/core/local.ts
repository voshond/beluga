import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FsEntry } from '../protocol.js';

export { localDirKey } from './local-key.js';

/** Folders on this computer, for "/project add" completion (size 1 = git project). */
export function listLocalDirs(dir: string): FsEntry[] {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let git = false;
        try {
          git = statSync(path.join(abs, d.name, '.git')).isDirectory();
        } catch {
          git = false;
        }
        return { name: d.name, dir: true, size: git ? 1 : 0 };
      })
      .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface BrowsedDir {
  readonly path: string;
  readonly parent?: string;
  readonly home: string;
  readonly dirs: ReadonlyArray<{ readonly name: string; readonly git: boolean }>;
}

/**
 * A folder for a browser's folder picker (it can't see this computer's): its absolute path, its
 * parent, home, and the folders in it (git repositories first, hidden ones left out). A folder
 * that can't be read shows empty; one that isn't there falls back to home.
 */
export function browseDir(dir?: string): BrowsedDir {
  const home = os.homedir();
  let abs = path.resolve((dir ?? '~').replace(/^~(?=$|[\\/])/, home));
  try {
    if (!statSync(abs).isDirectory()) abs = path.dirname(abs);
  } catch {
    abs = home;
  }
  const parent = path.dirname(abs);
  const dirs = listLocalDirs(abs)
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, git: d.size === 1 }));
  return { path: abs, ...(parent !== abs ? { parent } : {}), home, dirs };
}

/** Open a folder (or file, or URL) with the system's default app. */
export { systemOpen as openWithSystem } from './os-open.js';
