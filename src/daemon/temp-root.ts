import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive } from './files.js';

const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;
const ROOT_NAME = /^beluga-run-[a-z]+-(\d+)-[A-Za-z0-9]{6}$/;

export type TempRoot = {
  readonly root: string;
  readonly remove: () => void;
};

const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

export const sweepTempRoots = (base: string): string[] => {
  const swept: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return swept;
  }
  for (const name of names) {
    const pid = Number(ROOT_NAME.exec(name)?.[1]);
    if (!pid || alive(pid)) continue;
    try {
      removeDir(path.join(base, name));
      swept.push(name);
    } catch {
      continue;
    }
  }
  return swept;
};

export const ownTempRoot = (kind: string): TempRoot => {
  const base = os.tmpdir();
  sweepTempRoots(base);
  const root = mkdtempSync(path.join(base, `beluga-run-${kind}-${process.pid}-`));
  const before = TEMP_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_VARS) process.env[name] = root;
  const remove = (): void => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      removeDir(root);
    } catch {
      return;
    }
  };
  return { root, remove };
};
