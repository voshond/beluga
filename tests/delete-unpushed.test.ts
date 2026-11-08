import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unpushedCommits } from '../src/workspaces/git.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { branchState } from '../src/core/branch-state.js';
import type { Workspace } from '../src/workspaces/types.js';
import { deletesSettled } from '../src/workspaces/others.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();
const commitIn = (dir: string, file: string, msg: string) => {
  writeFileSync(path.join(dir, file), `${msg}\n`);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', msg);
};
const writeLines = (dir: string, file: string, lines: readonly string[]) => writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);

let base: string;
let repo: string;
let mgr: WorkspaceManager;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-unpushed-')));
  const origin = path.join(base, 'app.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  commitIn(repo, 'README.md', 'init');
  sh(repo, 'remote', 'add', 'origin', origin);
  sh(repo, 'push', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', 'main');
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  mgr = new WorkspaceManager(store);
  await mgr.refresh();
});

// Archiving deletes the folder it set aside in the background: let that finish first, or the two deletes race.
afterEach(async () => {
  await deletesSettled();
  rmSync(base, { recursive: true, force: true });
});

const project = () => mgr.list.find((p) => p.root)!;

/** Squash-merge a branch into main and push main, as GitHub's Squash and Merge does; the branch itself is never pushed. */
const squashIntoMain = (branch: string) => {
  sh(repo, 'merge', '--squash', branch);
  sh(repo, 'commit', '-m', `squash ${branch}`);
  sh(repo, 'push', 'origin', 'main');
};

describe('deleting a worktree with commits pushed nowhere (BLG-617)', () => {
  it('counts the commits only its branch has, and none once they are pushed', async () => {
    const ws = await mgr.createWorktree(project().id, 'readme');
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();

    commitIn(ws.path, 'a.txt', 'scene GIFs');
    commitIn(ws.path, 'b.txt', 'shorter README');
    expect(await mgr.deletePlan(ws.id)).toEqual({ branch: 'beluga/readme', into: 'origin/main', unpushed: 2, subjects: ['shorter README', 'scene GIFs'] });
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ ahead: 2, unpushed: 2 });

    // Pushed: the remote has them, so deleting the branch loses nothing.
    sh(ws.path, 'push', '-u', 'origin', 'beluga/readme');
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();
    commitIn(ws.path, 'c.txt', 'after the push');
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 1, subjects: ['after the push'] });
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ ahead: 3, unpushed: 1 });
  });

  it('none once its work landed in the base, squashed', async () => {
    const ws = await mgr.createWorktree(project().id, 'squashed');
    commitIn(ws.path, 'a.txt', 'one');
    commitIn(ws.path, 'b.txt', 'two');
    // Squash-merged into main and pushed; the branch itself never was.
    sh(repo, 'merge', '--squash', 'beluga/squashed');
    sh(repo, 'commit', '-m', 'squash');
    sh(repo, 'push', 'origin', 'main');
    sh(repo, 'fetch', 'origin');
    expect(await unpushedCommits(repo, 'beluga/squashed', 'origin/main')).toEqual({ count: 0, subjects: [] });
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();
  });

  it('none once it was squash-merged, even after a later change to one of its files on main (BLG-831)', async () => {
    commitIn(repo, 'notes.md', ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom'].join('\n'));
    sh(repo, 'push', 'origin', 'main');
    const ws = await mgr.createWorktree(project().id, 'squashed-then-edited');
    writeLines(ws.path, 'notes.md', ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom from the branch']);
    sh(ws.path, 'commit', '-am', 'bottom');
    commitIn(ws.path, 'b.txt', 'two');
    squashIntoMain('beluga/squashed-then-edited');
    // A later pull request edits the same file elsewhere: the file no longer reads as the branch left it.
    writeLines(repo, 'notes.md', ['top from main', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom from the branch']);
    sh(repo, 'commit', '-am', 'later PR');
    sh(repo, 'push', 'origin', 'main');
    sh(repo, 'fetch', 'origin');
    expect(await unpushedCommits(repo, 'beluga/squashed-then-edited', 'origin/main')).toEqual({ count: 0, subjects: [] });
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ landed: true });
    expect(mgr.find(ws.id)?.status?.unpushed).toBeUndefined();

    // Work after that, not in main: still lost with the branch.
    commitIn(ws.path, 'c.txt', 'after the merge');
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 3, subjects: ['after the merge', 'two', 'bottom'] });
  });

  it('a real change main never got still warns, though main changed the same file', async () => {
    commitIn(repo, 'notes.md', ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom'].join('\n'));
    sh(repo, 'push', 'origin', 'main');
    const ws = await mgr.createWorktree(project().id, 'not-merged');
    writeLines(ws.path, 'notes.md', ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom from the branch']);
    sh(ws.path, 'commit', '-am', 'bottom');
    writeLines(repo, 'notes.md', ['top from main', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom']);
    sh(repo, 'commit', '-am', 'other PR');
    sh(repo, 'push', 'origin', 'main');
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 1, subjects: ['bottom'] });
  });

  it('none once its own pull request shipped, even where main later rewrote its lines; commits after the merge still warn', async () => {
    const ws = await mgr.createWorktree(project().id, 'shipped');
    commitIn(ws.path, 'a.txt', 'one');
    const head = sh(ws.path, 'rev-parse', 'HEAD').trim();
    squashIntoMain('beluga/shipped');
    // A later pull request rewrites the very line: merging the branch now conflicts, so only the PR says it shipped.
    commitIn(repo, 'a.txt', 'one, rewritten');
    sh(repo, 'push', 'origin', 'main');
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 1 });
    // Merged on GitHub with that head (the PR Beluga shows as Merged): GitHub keeps it.
    expect(await mgr.deletePlan(ws.id, [head])).toBeUndefined();
    // Continue After Merge kept it as prShipped.
    mgr.setPrDone(ws.id, 7, { into: 'main', head });
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();

    commitIn(ws.path, 'b.txt', 'after the merge');
    expect(await mgr.deletePlan(ws.id)).toEqual({ branch: 'beluga/shipped', into: 'origin/main', unpushed: 1, subjects: ['after the merge'] });
    // A head this repository doesn't have proves nothing.
    expect(await unpushedCommits(repo, 'beluga/shipped', 'origin/main', ['0123456789abcdef0123456789abcdef01234567', '--all'])).toMatchObject({ count: 2 });
  });

  it("the Delete step's hint agrees with Delete once GitHub says its PR merged, even where main later rewrote its lines (BLG-833)", async () => {
    const ws = await mgr.createWorktree(project().id, 'hint');
    commitIn(ws.path, 'a.txt', 'one');
    const head = sh(ws.path, 'rev-parse', 'HEAD').trim();
    squashIntoMain('beluga/hint');
    commitIn(repo, 'a.txt', 'one, rewritten');
    sh(repo, 'push', 'origin', 'main');
    const state = { projects: mgr.list, gh: undefined, prs: { [ws.id]: { number: 7, state: 'MERGED' as const } }, conflicts: {} } as unknown as Parameters<typeof branchState>[0];
    const hint = () => branchState(state, mgr.find(ws.id)!)?.steps.find((s) => s.id === 'delete')?.hint;
    await mgr.refresh();
    expect(mgr.find(ws.id)?.status).toMatchObject({ unpushed: 1 });

    // Polling heard it merged at this commit.
    expect(mgr.setMergedHead(ws.id, head)).toBe(true);
    expect(mgr.setMergedHead(ws.id, head)).toBe(false);
    await mgr.refreshWorkspace(ws.path);
    expect(mgr.find(ws.id)?.status?.unpushed).toBeUndefined();
    expect(hint()).toBe('Remove the folder and its branch for good');
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();
    // Kept across a restart: it's on the record.
    const restarted = new WorkspaceManager(new WorkspaceStore(path.join(base, 'home')));
    await restarted.refresh();
    expect(restarted.find(ws.id)).toMatchObject({ mergedHead: head });
    expect(restarted.find(ws.id)?.status?.unpushed).toBeUndefined();

    commitIn(ws.path, 'b.txt', 'after the merge');
    await mgr.refreshWorkspace(ws.path);
    expect(mgr.find(ws.id)?.status).toMatchObject({ unpushed: 1 });
    expect(hint()).toMatch(/^1 commit on beluga\/hint was never pushed/);
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 1, subjects: ['after the merge'] });
  });

  // The old git is a shell script put first on PATH: Windows finds git.exe instead.
  it.skipIf(process.platform === 'win32')('with a git older than merge-tree --write-tree, it warns as before', async () => {
    commitIn(repo, 'notes.md', ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom'].join('\n'));
    sh(repo, 'push', 'origin', 'main');
    const ws = await mgr.createWorktree(project().id, 'old-git');
    writeLines(ws.path, 'notes.md', ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom from the branch']);
    sh(ws.path, 'commit', '-am', 'bottom');
    squashIntoMain('beluga/old-git');
    writeLines(repo, 'notes.md', ['top from main', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'bottom from the branch']);
    sh(repo, 'commit', '-am', 'later PR');
    sh(repo, 'push', 'origin', 'main');
    // A git that has no `merge-tree --write-tree` (before 2.38): it says so and exits 129.
    const bin = path.join(base, 'old-git-bin');
    mkdirSync(bin);
    const real = execFileSync('which', ['git']).toString().trim();
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--write-tree" ] && { echo "error: unknown option \\\`write-tree'" >&2; exit 129; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${PATH}`;
    try {
      vi.resetModules();
      const old = await import('../src/workspaces/git.js');
      expect(await old.contentIn(repo, 'beluga/old-git', 'origin/main')).toBeUndefined();
      expect(await old.unpushedCommits(repo, 'beluga/old-git', 'origin/main')).toEqual({ count: 1, subjects: ['bottom'] });
    } finally {
      process.env.PATH = PATH;
    }
  });

  it('none once it was squash-merged on the remote since the last fetch: it checks there before warning (BLG-746)', async () => {
    const ws = await mgr.createWorktree(project().id, 'merged-on-github');
    commitIn(ws.path, 'a.txt', 'one');
    commitIn(ws.path, 'b.txt', 'two');
    // Merged in the browser: the same change lands on origin's main, and nothing here has fetched it.
    const other = path.join(base, 'other');
    execFileSync('git', ['clone', '-q', path.join(base, 'app.git'), other], { stdio: 'pipe' });
    writeFileSync(path.join(other, 'a.txt'), 'one\n');
    writeFileSync(path.join(other, 'b.txt'), 'two\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-m', 'one and two (#1)');
    sh(other, 'push', 'origin', 'main');
    expect(await unpushedCommits(repo, 'beluga/merged-on-github', 'origin/main')).toMatchObject({ count: 2 });
    expect(await mgr.deletePlan(ws.id)).toBeUndefined();
  });

  it('offline, it warns from what it has', async () => {
    const ws = await mgr.createWorktree(project().id, 'offline');
    commitIn(ws.path, 'a.txt', 'only here');
    sh(repo, 'remote', 'set-url', 'origin', path.join(base, 'gone.git'));
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 1, subjects: ['only here'] });
  });

  it('still warns for an archived worktree: its branch is all that is left', async () => {
    const ws = await mgr.createWorktree(project().id, 'kept');
    commitIn(ws.path, 'a.txt', 'only here');
    await mgr.archive(ws.id);
    expect(await mgr.deletePlan(ws.id)).toMatchObject({ unpushed: 1, subjects: ['only here'] });
  });

  it('a branch that is gone, or not a branch, has nothing to lose', async () => {
    expect(await unpushedCommits(repo, 'no-such-branch', 'main')).toEqual({ count: 0, subjects: [] });
    expect(await unpushedCommits(repo, '--all', 'main')).toEqual({ count: 0, subjects: [] });
  });

  it("the Delete step's hint says how many, for the phone's confirm", async () => {
    const ws = await mgr.createWorktree(project().id, 'merged');
    const state = { projects: mgr.list, gh: undefined, prs: { [ws.id]: { number: 7, state: 'MERGED' as const } }, conflicts: {} } as unknown as Parameters<typeof branchState>[0];
    const at = (status: Workspace['status']): Workspace => ({ ...mgr.find(ws.id)!, ...(status ? { status } : {}) });
    const del = (status: Workspace['status']) => branchState(state, at(status))?.steps.find((s) => s.id === 'delete');
    expect(del({ changed: 0, ahead: 3, behind: 0 })?.hint).toBe('Remove the folder and its branch for good');
    expect(del({ changed: 0, ahead: 3, behind: 0, unpushed: 2 })?.hint).toBe('2 commits on beluga/merged were never pushed or merged into main: deleting loses them and the conversation. Archive keeps both.');
    expect(del({ changed: 0, ahead: 3, behind: 0, unpushed: 1 })?.hint).toMatch(/^1 commit on beluga\/merged was never pushed .* loses it and/);
    // Archive is offered beside it, first: the phone's confirm leads with it.
    expect(branchState(state, at({ changed: 0, ahead: 3, behind: 0, unpushed: 2 }))?.steps[0]?.id).toBe('archive');
  });
});
