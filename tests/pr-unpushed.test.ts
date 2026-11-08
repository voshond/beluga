import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { headCarries, unpushedCommits } from '../src/workspaces/pr.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function commit(dir: string, file: string, message: string): void {
  writeFileSync(path.join(dir, file), `${message}\n`);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', message);
}

describe('commits a merge on GitHub would leave behind', () => {
  it('counts what HEAD has that the branch on origin doesn’t, and says 0 when git can’t tell', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-unpushed-'));
    sh(dir, 'init', '-q', '-b', 'beluga/voice');
    sh(dir, 'config', 'user.email', 't@t');
    sh(dir, 'config', 'user.name', 'Tess');
    commit(dir, 'a.txt', 'Phone: a mic in Ask');
    // Never pushed: no origin/beluga/voice to compare with.
    expect(await unpushedCommits(dir, 'beluga/voice')).toBe(0);
    sh(dir, 'update-ref', 'refs/remotes/origin/beluga/voice', 'HEAD');
    expect(await unpushedCommits(dir, 'beluga/voice')).toBe(0);
    commit(dir, 'b.txt', 'Voice v2: written down while you talk');
    commit(dir, 'c.txt', 'Phone voice: a metaballs blob');
    expect(await unpushedCommits(dir, 'beluga/voice')).toBe(2);
    sh(dir, 'update-ref', 'refs/remotes/origin/beluga/voice', 'HEAD');
    expect(await unpushedCommits(dir, 'beluga/voice')).toBe(0);
    expect(await unpushedCommits(path.join(dir, 'missing'), 'beluga/voice')).toBe(0);
  });
});

describe('whether a pull request’s head has every commit here (BLG-840)', () => {
  it('true at HEAD or past it (Update Branch on GitHub), false behind it, unknown for a head that isn’t here', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-carries-'));
    sh(dir, 'init', '-q', '-b', 'beluga/preview');
    sh(dir, 'config', 'user.email', 't@t');
    sh(dir, 'config', 'user.name', 'Tess');
    commit(dir, 'a.txt', 'Live previews in chat');
    const pushed = sh(dir, 'rev-parse', 'HEAD');
    expect(await headCarries(dir, pushed)).toEqual({ head: pushed, carries: true });
    commit(dir, 'b.txt', 'Previews: a second round');
    commit(dir, 'c.txt', 'Previews: a third round');
    const head = sh(dir, 'rev-parse', 'HEAD');
    // The PR stayed at the first round: two rounds aren't on it.
    expect(await headCarries(dir, pushed)).toEqual({ head, carries: false });
    // GitHub merged the base into the PR after a push: HEAD is in it.
    sh(dir, 'checkout', '-q', '-b', 'on-github');
    commit(dir, 'd.txt', 'Merge main into beluga/preview');
    const ahead = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', 'beluga/preview');
    expect(await headCarries(dir, ahead)).toEqual({ head, carries: true });
    expect(await headCarries(dir, 'f'.repeat(40))).toEqual({ head });
    expect(await headCarries(dir, undefined)).toEqual({ head });
    expect(await headCarries(dir, '--not-a-sha')).toEqual({ head });
    expect(await headCarries(path.join(dir, 'missing'), pushed)).toEqual({});
  });
});
