import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropBranches, localBranches, sendBranches, takeBranches } from '../src/core/plans/move-git.js';

/** BLG-806: a moving plan's branches go over the link in a bundle when the project has no origin. */

const dirs: string[] = [];
const repo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'move-git-'));
  dirs.push(dir);
  const g = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start');
  return dir;
};
const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('a plan’s branches between two clones (BLG-806)', () => {
  it('bundles the branches that are there and takes them in on the other side; a failed move takes out only what it made', async () => {
    const a = repo();
    git(a, 'branch', 'plan/parser');
    git(a, 'checkout', '-q', '-b', 'beluga/lexer');
    git(a, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'lexer');
    const sent = await sendBranches(a, ['plan/parser', 'beluga/lexer', 'beluga/gone']);
    expect(sent).toMatchObject({ via: 'bundle', branches: ['plan/parser', 'beluga/lexer'] });

    const b = repo();
    // Its plan/parser went another way there: it stays as it is, and the rest still come.
    git(b, 'checkout', '-q', '-b', 'plan/parser');
    git(b, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'theirs');
    git(b, 'checkout', '-q', 'main');
    const made = await takeBranches(b, sent!);
    expect(made).toEqual(['beluga/lexer']);
    expect(git(b, 'log', '-1', '--format=%s', 'beluga/lexer')).toBe('lexer');
    expect(git(b, 'log', '-1', '--format=%s', 'plan/parser')).toBe('theirs');
    await dropBranches(b, made);
    expect(await localBranches(b, ['plan/parser', 'beluga/lexer'])).toEqual(['plan/parser']);
  });

  it('nothing to send when none of them is there', async () => {
    expect(await sendBranches(repo(), ['beluga/nope'])).toBeUndefined();
  });
});
