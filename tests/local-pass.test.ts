import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAILER, suiteSize, trailerFor, wholeSuitePassed, workingTree } from '../scripts/local-pass.mjs';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-local-pass-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@test');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, '.gitignore'), 'out/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

describe('a run that passed on a Mac, for the commit', () => {
  it("names the files as git will commit them: untracked ones count, ignored ones don't, the real index is left alone", () => {
    const dir = repo();
    expect(workingTree(dir)).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    const tested = workingTree(dir)!;
    expect(tested).not.toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    expect(git(dir, 'status', '--porcelain')).toBe('?? b.ts');
    // Ignored output changes nothing.
    mkdirSync(path.join(dir, 'out'));
    writeFileSync(path.join(dir, 'out', 'x.js'), '1');
    expect(workingTree(dir)).toBe(tested);
    // Committing exactly what was tested gives the same tree, which CI compares against.
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `add b\n\n${trailerFor(tested)}`);
    expect(git(dir, 'rev-parse', 'HEAD^{tree}')).toBe(tested);
    expect(git(dir, 'log', '-1', '--format=%B').split('\n')).toContain(`${TRAILER} ${tested}`);
    // One more change after the run: a different tree, so CI tests it.
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 3;\n');
    expect(workingTree(dir)).not.toBe(tested);
  });

  it('is nothing outside git', () => {
    expect(workingTree(mkdtempSync(path.join(os.tmpdir(), 'beluga-no-git-')))).toBeUndefined();
  });

  it('counts only the whole suite passing', () => {
    const ok = { reason: 'passed', errors: 0, modules: 430, suite: 430, namePattern: undefined };
    expect(wholeSuitePassed(ok)).toBe(true);
    expect(wholeSuitePassed({ ...ok, reason: 'failed' })).toBe(false);
    expect(wholeSuitePassed({ ...ok, reason: 'interrupted' })).toBe(false);
    expect(wholeSuitePassed({ ...ok, errors: 1 })).toBe(false);
    // One file, a shard, or -t: not the whole suite.
    expect(wholeSuitePassed({ ...ok, modules: 1 })).toBe(false);
    expect(wholeSuitePassed({ ...ok, namePattern: /login/ })).toBe(false);
  });

  it('knows the size of the suite', () => {
    expect(suiteSize(path.join(import.meta.dirname, '..', 'tests'))).toBeGreaterThan(400);
  });

  it("is what CI's macOS run looks for", () => {
    const ci = readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain(`grep -qxF "${TRAILER} $tree"`);
  });
});
