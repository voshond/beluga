import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownTempRoot, sweepTempRoots } from '../src/daemon/temp-root.js';

const made: string[] = [];

const freshBase = (): string => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'temp-root-'));
  made.push(base);
  return base;
};

const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid ?? 0;
};

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sweepTempRoots', () => {
  it('removes roots of runs that died and keeps the rest', () => {
    const base = freshBase();
    const dead = `beluga-run-test-${deadPid()}-abc123`;
    const live = `beluga-run-test-${process.pid}-def456`;
    const other = 'beluga-test-home-xyz789';
    for (const name of [dead, live, other]) mkdirSync(path.join(base, name));
    writeFileSync(path.join(base, dead, 'leftover'), 'x');

    expect(sweepTempRoots(base)).toEqual([dead]);
    expect(existsSync(path.join(base, dead))).toBe(false);
    expect(existsSync(path.join(base, live))).toBe(true);
    expect(existsSync(path.join(base, other))).toBe(true);
  });

  it('shrugs at a folder that is not there', () => {
    expect(sweepTempRoots(path.join(freshBase(), 'missing'))).toEqual([]);
  });
});

describe('ownTempRoot', () => {
  it('points the temp variables at its root and puts them back on remove', () => {
    const before = process.env.TMPDIR;
    const { root, remove } = ownTempRoot('unit');

    expect(path.basename(root)).toMatch(new RegExp(`^beluga-run-unit-${process.pid}-`));
    expect(process.env.TMPDIR).toBe(root);
    expect(os.tmpdir()).toBe(root);
    writeFileSync(path.join(mkdtempSync(path.join(os.tmpdir(), 'inner-')), 'file'), 'x');

    remove();
    expect(existsSync(root)).toBe(false);
    expect(process.env.TMPDIR).toBe(before);
  });
});
