import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacAssistant } from '../src/core/assistant/assistant.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { Store, initialState } from '../src/core/store.js';
import { SCRATCH_DIR, SCRATCH_KEEP_MS, scratchTotal, tidyScratch } from '../src/workspaces/scratch.js';
import { scratchBytes, scratchCount } from '../packages/mac/src/layout/panel/scratch-model.js';
import { waitFor } from './helpers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4);
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-mac-scratch-'));

/** A file in the scratch folder, last written `daysAgo` before NOW. */
function put(dir: string, rel: string, daysAgo: number, body = 'x'): void {
  const file = path.join(dir, SCRATCH_DIR, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  const at = (NOW - daysAgo * DAY) / 1000;
  utimesSync(file, at, at);
}

/** Pretend Trash: the names put in it (the files stay where they are). */
function trashBin(): { readonly moved: string[]; readonly trash: (abs: string) => Promise<void> } {
  const moved: string[] = [];
  return { moved, trash: async (abs) => void moved.push(path.basename(abs)) };
}

/** Folders' own times are when they were made (now): only what's in them should count. */
function ageFolder(dir: string, rel: string, daysAgo: number): void {
  const at = (NOW - daysAgo * DAY) / 1000;
  utimesSync(path.join(dir, SCRATCH_DIR, rel), at, at);
}

describe('tidying a scratch folder (BLG-704)', () => {
  it('puts what nobody touched for a month in the Trash, and keeps the rest', async () => {
    const dir = tmp();
    put(dir, 'old-shot.png', 40);
    put(dir, 'fresh-log.txt', 2);
    put(dir, 'old-folder/a.json', 45);
    put(dir, 'old-folder/b/c.txt', 35);
    ageFolder(dir, 'old-folder/b', 35);
    ageFolder(dir, 'old-folder', 35);
    // A folder with one file still in use stays whole.
    put(dir, 'busy/old.png', 60);
    put(dir, 'busy/new.png', 1);
    ageFolder(dir, 'busy', 60);
    const bin = trashBin();
    expect(await tidyScratch(dir, { now: NOW, trash: bin.trash })).toEqual(['old-folder', 'old-shot.png']);
    expect(bin.moved).toEqual(['old-folder', 'old-shot.png']);
  });

  it('keeps 30 days by default', () => {
    expect(SCRATCH_KEEP_MS).toBe(30 * DAY);
  });

  it('never deletes outright: what won’t go to the Trash stays for next time', async () => {
    const dir = tmp();
    put(dir, 'stuck.png', 90);
    const gone = await tidyScratch(dir, {
      now: NOW,
      trash: async () => {
        throw new Error('no Trash here');
      },
    });
    expect(gone).toEqual([]);
    expect(existsSync(path.join(dir, SCRATCH_DIR, 'stuck.png'))).toBe(true);
  });

  it('leaves a scratch folder that is a link to somewhere else alone, and copes with none at all', async () => {
    const outside = tmp();
    put(outside, 'old.png', 90);
    const dir = tmp();
    mkdirSync(path.join(dir, '.beluga'));
    symlinkSync(path.join(outside, SCRATCH_DIR), path.join(dir, SCRATCH_DIR));
    const bin = trashBin();
    expect(await tidyScratch(dir, { now: NOW, trash: bin.trash })).toEqual([]);
    expect(await tidyScratch(tmp(), { now: NOW, trash: bin.trash })).toEqual([]);
    expect(bin.moved).toEqual([]);
  });
});

describe('how much a scratch folder holds', () => {
  it('counts every file however deep, and keeps the count a moment', async () => {
    const dir = tmp();
    put(dir, 'a.txt', 1, 'abc');
    put(dir, 'one/two/three/four/five/deep.txt', 1, 'hello');
    expect(await scratchTotal(dir, 1_000)).toEqual({ files: 2, bytes: 8 });
    put(dir, 'b.txt', 1, 'xy');
    expect(await scratchTotal(dir, 2_000)).toEqual({ files: 2, bytes: 8 });
    expect(await scratchTotal(dir, 60_000)).toEqual({ files: 3, bytes: 10 });
  });

  it('says how many there are, and when the list shows only the newest', () => {
    expect(scratchCount(1)).toBe('1 file');
    expect(scratchCount(68, { files: 68, bytes: 1 })).toBe('68 files');
    expect(scratchCount(300, { files: 5578, bytes: 1 })).toBe('300 of 5,578 files');
  });

  it('says how much from the list while it has every file (a count kept a moment may be behind it)', () => {
    const files = [
      { path: 'a', size: 4096, mtime: 1 },
      { path: 'b', size: 79, mtime: 1 },
    ];
    expect(scratchBytes(files, { files: 0, bytes: 0 })).toBe(4175);
    expect(scratchBytes(files, { files: 5000, bytes: 145_000_000 })).toBe(145_000_000);
    expect(scratchBytes(files)).toBeUndefined();
  });
});

describe('Your Mac’s scratch folder', () => {
  const mac = (extra: Partial<ConstructorParameters<typeof MacAssistant>[0]> = {}) => {
    const dir = tmp();
    const a = new MacAssistant({ store: new Store(initialState('room', 'auto')), dir, selfId: () => 'me', system: pretendSystem(), now: () => NOW, ...extra });
    return { a, work: path.join(dir, 'work') };
  };

  it('lists what its Claude saved, with how much it holds, for the Mac’s Scratch tab', async () => {
    const { a, work } = mac({ tidy: false });
    put(work, 'screens/shot.png', 0, 'png!');
    put(work, 'notes.md', 1, 'hi');
    const res = await a.scratch();
    expect(res.root).toBe(work);
    expect(res.dir).toBe(path.join(work, SCRATCH_DIR));
    expect(res.files.map((f) => f.path)).toEqual([`${SCRATCH_DIR}/screens/shot.png`, `${SCRATCH_DIR}/notes.md`]);
    expect(res.total).toEqual({ files: 2, bytes: 6 });
    a.stop();
  });

  it('tidies itself soon after starting, then again on its own', async () => {
    const bin = trashBin();
    const { a, work } = mac({ trash: bin.trash, tidy: { firstMs: 5, everyMs: 5 } });
    put(work, 'old.png', 31);
    put(work, 'new.png', 3);
    await waitFor(() => bin.moved.length >= 2);
    expect(bin.moved.every((n) => n === 'old.png')).toBe(true);
    a.stop();
  });
});
