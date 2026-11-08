import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import { pullOfBranch } from '../src/workspaces/github.js';
import { WorkspaceManager, pullName } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { screenOver } from './helpers.js';

/**
 * A pull request in a worktree (BLG-633), against real repositories: a bare origin with a
 * teammate's branch on it and a fork's pull ref (refs/pull/<n>/head, as GitHub keeps it), and the
 * project's main folder. Its own branch tracks origin's (a push updates it); a fork's gets pr-<n>.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let base: string;
let repo: string;
let mate: string;
let store: Store;
let toasts: string[];
let mgr: WorkspaceManager;
let ctl: WorkspaceController;

function mateCommits(branch: string, file: string, text: string): string {
  git(mate, 'switch', '-q', '-C', branch, 'origin/main');
  writeFileSync(path.join(mate, file), text);
  git(mate, 'add', '.');
  git(mate, 'commit', '-q', '-m', `${branch}: ${file}`);
  return git(mate, 'rev-parse', 'HEAD').trim();
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-pull-')));
  const origin = path.join(base, 'app.git');
  repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), 'app\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  mate = path.join(base, 'mate');
  execFileSync('git', ['clone', '-q', origin, mate]);
  mateCommits('fix/email', 'email.ts', 'decode\n');
  git(mate, 'push', '-q', 'origin', 'fix/email');
  mateCommits('their-fork-branch', 'fork.ts', 'from a fork\n');
  git(mate, 'push', '-q', 'origin', 'their-fork-branch:refs/pull/7/head');
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  store = new Store(initialState('room'));
  toasts = [];
  mgr = new WorkspaceManager(wsStore);
  ctl = new WorkspaceController({ manager: mgr, store, shares: new ShareService([]), selfId: () => 'me', toast: (t) => void toasts.push(t), intend: screenOver(store).intend, askClaude: () => undefined });
  await ctl.refresh();
});

const pid = () => mgr.list.find((p) => p.root)!.id;
const said = (id: string) => store.getState().log.filter((l) => l.channel === `ws:${id}` && l.type === 'system').map((l) => (l.type === 'system' ? l.text : ''));

describe('a pull request in a worktree', () => {
  it('checks out its own branch, tracking origin’s, compared with the branch it merges into', async () => {
    const ws = await ctl.openPull(pid(), { number: 12, branch: 'fix/email', title: 'Decode emails', base: 'main' });
    expect(ws).toMatchObject({ kind: 'worktree', branch: 'fix/email', base: 'origin/main', name: 'pr-12-decode-emails' });
    expect(readFileSync(path.join(ws!.path, 'email.ts'), 'utf8')).toBe('decode\n');
    // A push there goes to the pull request's branch.
    expect(git(ws!.path, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/fix/email');
    expect(said(ws!.id).join(' ')).toMatch(/#12 “Decode emails”, checked out on fix\/email\. Pushing here updates the pull request/);
    expect(toasts.at(-1)).toMatch(/#12 is checked out/);
  });

  it('opens the worktree already on its branch instead of making another, and a double click makes one', async () => {
    const pull = { number: 12, branch: 'fix/email', title: 'Decode emails' };
    const [a, b] = await Promise.all([ctl.openPull(pid(), pull), ctl.openPull(pid(), pull)]);
    expect(a!.id).toBe(b!.id);
    const again = await ctl.openPull(pid(), pull);
    expect(again!.id).toBe(a!.id);
    expect(mgr.list.find((p) => p.root)!.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(1);
  });

  it('uses a local branch of that name as it is, caught up with origin when it can be', async () => {
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '-q', 'fix/email', 'main');
    const ws = await ctl.openPull(pid(), { number: 12, branch: 'fix/email' });
    expect(git(ws!.path, 'rev-parse', 'HEAD').trim()).toBe(git(repo, 'rev-parse', 'origin/fix/email').trim());
  });

  it('says where its branch is when it is checked out outside Beluga', async () => {
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'switch', '-q', '-c', 'fix/email', '--track', 'origin/fix/email');
    expect(await ctl.openPull(pid(), { number: 12, branch: 'fix/email' })).toBeUndefined();
    expect(toasts.at(-1)).toMatch(/Couldn't open #12 in a worktree: fix\/email is already checked out in/);
  });

  it('gets a fork’s from GitHub’s pull ref, on its branch’s name, and git pull keeps it current', async () => {
    const ws = await ctl.openPull(pid(), { number: 7, branch: 'their-fork-branch', title: 'From a fork', fork: true });
    expect(ws).toMatchObject({ branch: 'their-fork-branch', name: 'pr-7-from-a-fork' });
    expect(readFileSync(path.join(ws!.path, 'fork.ts'), 'utf8')).toBe('from a fork\n');
    expect(git(repo, 'config', 'branch.their-fork-branch.merge').trim()).toBe('refs/pull/7/head');
    // So its PR is looked up by number: gh finds no fork's PR by the branch's name alone.
    expect(pullOfBranch(ws!.path, ws!.branch!)).toBe(7);
    // The fork pushes again: git pull brings it.
    writeFileSync(path.join(mate, 'fork.ts'), 'more\n');
    git(mate, 'commit', '-q', '-am', 'more');
    git(mate, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    git(ws!.path, 'pull', '-q', '--ff-only');
    expect(readFileSync(path.join(ws!.path, 'fork.ts'), 'utf8')).toBe('more\n');
    expect(said(ws!.id).join(' ')).toMatch(/from a fork, so pushing here doesn’t change it/);
    // Opening it again finds that worktree.
    expect((await ctl.openPull(pid(), { number: 7, branch: 'their-fork-branch', fork: true }))!.id).toBe(ws!.id);
  });

  it('a fork’s commits are on GitHub, so deleting it loses none of them; yours on top it warns about (BLG-746)', async () => {
    const ws = await ctl.openPull(pid(), { number: 7, branch: 'their-fork-branch', title: 'From a fork', fork: true });
    expect(await mgr.deletePlan(ws!.id)).toBeUndefined();
    await mgr.refresh();
    expect(mgr.find(ws!.id)?.status).toMatchObject({ ahead: 1 });
    expect(mgr.find(ws!.id)?.status?.unpushed).toBeUndefined();
    writeFileSync(path.join(ws!.path, 'mine.ts'), 'mine\n');
    git(ws!.path, 'add', '.');
    git(ws!.path, 'commit', '-q', '-m', 'mine');
    expect(await mgr.deletePlan(ws!.id)).toMatchObject({ unpushed: 1, subjects: ['mine'] });
    await mgr.remove(ws!.id);
    expect(git(repo, 'for-each-ref', 'refs/beluga/pulls').trim()).toBe('');
  });

  it('a fork’s worktree made before its head was kept fetches it before warning', async () => {
    const ws = await ctl.openPull(pid(), { number: 7, branch: 'their-fork-branch', fork: true });
    git(repo, 'update-ref', '-d', 'refs/beluga/pulls/7');
    expect(await mgr.deletePlan(ws!.id)).toBeUndefined();
    expect(git(repo, 'rev-parse', 'refs/beluga/pulls/7').trim()).toBe(git(repo, 'rev-parse', 'their-fork-branch').trim());
  });

  it('puts a fork’s on pr-<n> when its branch’s name is taken here', async () => {
    git(repo, 'branch', '-q', 'patch-1');
    const ws = await ctl.openPull(pid(), { number: 7, branch: 'patch-1', fork: true });
    expect(ws).toMatchObject({ branch: 'pr-7', name: 'pr-7' });
    expect(readFileSync(path.join(ws!.path, 'fork.ts'), 'utf8')).toBe('from a fork\n');
  });

  it('names it pr-<n> and the first whole words of its title', () => {
    expect(pullName({ number: 51, title: 'Decode emails safely in the user lookup' })).toBe('pr-51-decode-emails-safely');
    expect(pullName({ number: 3 })).toBe('pr-3');
  });

  it('says so when its branch is gone from origin, and leaves nothing behind', async () => {
    expect(await ctl.openPull(pid(), { number: 9, branch: 'deleted/branch' })).toBeUndefined();
    expect(toasts.at(-1)).toMatch(/deleted\/branch isn’t on origin/);
    expect(mgr.list.find((p) => p.root)!.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(0);
  });
});
