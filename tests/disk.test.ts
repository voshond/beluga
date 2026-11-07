import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderSize, formatBytes, measureAll, walkSize } from '../src/workspaces/disk.js';

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe('formatBytes', () => {
  it.each([
    [0, '0 KB'],
    [-5000, '0 KB'],
    [512, '1 KB'],
    [100 * KB, '100 KB'],
    [MB - 1, '1024 KB'],
    [MB, '1 MB'],
    [340 * MB, '340 MB'],
    [GB, '1.0 GB'],
    [1.25 * GB, '1.3 GB'],
    [10 * GB - MB * 200, '9.8 GB'],
    [10 * GB, '10 GB'],
    [123.4 * GB, '123 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('measureAll', () => {
  it('measures one at a time, in order, and skips undefined', async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const measure = async (p: string) => {
      calls.push(p);
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return p === '/b' ? undefined : p.length * 100;
    };
    const out = await measureAll(
      [
        { id: 'a', path: '/a' },
        { id: 'b', path: '/b' },
        { id: 'c', path: '/ccc' },
      ],
      measure,
    );
    expect(calls).toEqual(['/a', '/b', '/ccc']);
    expect(maxActive).toBe(1);
    expect(out).toEqual({ a: 200, c: 400 });
  });

  it('tells each size as it comes, skipping undefined', async () => {
    const heard: [string, number][] = [];
    const out = await measureAll(
      [
        { id: 'a', path: '/a' },
        { id: 'b', path: '/b' },
      ],
      async (p) => (p === '/b' ? undefined : 7),
      (id, size) => heard.push([id, size]),
    );
    expect(heard).toEqual([['a', 7]]);
    expect(out).toEqual({ a: 7 });
  });

  it('returns {} for no folders', async () => {
    expect(await measureAll([], async () => 1)).toEqual({});
  });

  it('keeps zero sizes', async () => {
    expect(await measureAll([{ id: 'z', path: '/z' }], async () => 0)).toEqual({ z: 0 });
  });
});

describe('folderSize', () => {
  it('measures a real folder in bytes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-disk-'));
    writeFileSync(path.join(dir, 'blob'), Buffer.alloc(64 * KB, 1));
    const size = await folderSize(dir);
    expect(size).toBeGreaterThan(0);
    expect(size! % 1024).toBe(0);
    // At the lowest priority (BLG-407), the very number du gives. Windows has no du: walked in Node.
    if (process.platform === 'win32') expect(size).toBe(64 * KB);
    else expect(size).toBe(Number(/^(\d+)/.exec(execFileSync('du', ['-sk', dir]).toString())?.[1]) * 1024);
  });

  it('returns undefined for a missing folder', async () => {
    expect(await folderSize(path.join(os.tmpdir(), 'klaud-disk-missing-' + process.pid + '-' + Date.now()))).toBeUndefined();
  });
});

describe('walkSize', () => {
  it('sums nested files, rounded up to whole KiB, without following symlinks', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-walk-'));
    mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'top'), Buffer.alloc(KB + 1, 1)); // 2 KiB
    writeFileSync(path.join(dir, 'a', 'mid'), Buffer.alloc(3 * KB, 1)); // 3 KiB
    writeFileSync(path.join(dir, 'a', 'b', 'deep'), Buffer.alloc(10, 1)); // 1 KiB
    try {
      symlinkSync(path.join(dir, 'a'), path.join(dir, 'link'), 'junction');
    } catch {
      // No symlink rights here: the walk is tested without one.
    }
    expect(await walkSize(dir)).toBe(6 * KB);
  });

  it('returns undefined for a missing folder and 0 for an empty one', async () => {
    expect(await walkSize(path.join(os.tmpdir(), 'klaud-walk-missing-' + process.pid + '-' + Date.now()))).toBeUndefined();
    expect(await walkSize(mkdtempSync(path.join(os.tmpdir(), 'klaud-walk-empty-')))).toBe(0);
  });

  it('answers with what it counted when the time budget is up', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-walk-slow-'));
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'f'), Buffer.alloc(KB, 1));
    expect(await walkSize(dir, 0)).toBe(0);
  });
});
