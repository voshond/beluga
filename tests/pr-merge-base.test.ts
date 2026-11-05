import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeToBase } from '../src/workspaces/pr.js';

/** Merge into main with no PR (BLG-265): real git, a bare origin, a second clone pushing to main meanwhile. */

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, text: string, msg: string): void => {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', msg);
};
const clone = (origin: string, to: string): string => {
  execFileSync('git', ['clone', '-q', origin, to], { stdio: 'ignore' });
  git(to, 'config', 'user.email', 't@t');
  git(to, 'config', 'user.name', 'T');
  return to;
};

let origin: string;
let work: string;
let other: string;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'merge-base-'));
  origin = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  work = clone(origin, path.join(dir, 'work'));
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'a.txt', 'a\n', 'A');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feat');
  commit(work, 'b.txt', 'b\n', 'B');
  other = clone(origin, path.join(dir, 'other'));
});

const mainOnOrigin = (): string => git(origin, 'rev-parse', 'main');

describe('mergeToBase', () => {
  it('fast-forwards origin/main when nothing landed there since', async () => {
    const res = await mergeToBase(work, 'feat', 'main');
    expect(res).toMatchObject({ ok: true, how: 'fast_forward' });
    expect(mainOnOrigin()).toBe(git(work, 'rev-parse', 'feat'));
    expect(git(work, 'rev-parse', 'origin/main')).toBe(mainOnOrigin());
  });

  it('makes a merge commit when main moved, without touching the worktree', async () => {
    commit(other, 'c.txt', 'c\n', 'C');
    git(other, 'push', '-q', 'origin', 'main');
    const head = git(work, 'rev-parse', 'HEAD');
    const res = await mergeToBase(work, 'feat', 'main');
    expect(res).toMatchObject({ ok: true, how: 'merge_commit' });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    const parents = git(origin, 'rev-list', '--parents', '-n', '1', 'main').split(' ');
    expect(parents.slice(1)).toEqual([git(other, 'rev-parse', 'main'), head]);
    expect(git(origin, 'show', 'main:b.txt')).toBe('b');
    expect(git(origin, 'show', 'main:c.txt')).toBe('c');
  });

  it('stops on a conflict and pushes nothing', async () => {
    commit(other, 'b.txt', 'not b\n', 'B elsewhere');
    git(other, 'push', '-q', 'origin', 'main');
    const was = mainOnOrigin();
    const res = await mergeToBase(work, 'feat', 'main');
    expect(res).toEqual({ ok: false, reason: 'conflict', files: ['b.txt'] });
    expect(mainOnOrigin()).toBe(was);
  });
});
