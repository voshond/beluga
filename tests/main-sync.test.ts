import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import { describe as describeLine } from '../src/core/main-sync.js';
import { defaultBase } from '../src/workspaces/git.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { classifyFetchError, defaultBranch, dirtyFiles, fetchRemote, filesInTheWay, parseSymref, stashDrop, stashPush, updateDefault } from '../src/workspaces/sync.js';
import { screenOver } from './helpers.js';

/**
 * Update main against real repositories: a bare origin, the project's main folder, and a
 * teammate's clone that pushes new commits. Covers the fast-forward, changes in the way (stash
 * and back, or into a worktree), divergence (Claude's job), sign-in failures and a main folder
 * on another branch.
 */

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const fileWith = (edits: Record<number, string> = {}) => `${LINES.map((l, i) => edits[i] ?? l).join('\n')}\n`;

let base: string;
let origin: string;
let repo: string;
let mate: string;
let toasts: string[];
let asked: Array<{ prompt: string; channel: string }>;
let ctl: WorkspaceController;
let mgr: WorkspaceManager;

function teammatePushes(edits: Record<number, string>, message: string, file = 'notes.txt'): void {
  git(mate, 'pull', '-q', '--ff-only');
  writeFileSync(path.join(mate, file), file === 'notes.txt' ? fileWith(edits) : Object.values(edits).join('\n'));
  git(mate, 'add', '.');
  git(mate, 'commit', '-q', '-m', message);
  git(mate, 'push', '-q', 'origin', 'main');
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-sync-')));
  origin = path.join(base, 'app.git');
  repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'notes.txt'), fileWith());
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  mate = path.join(base, 'mate');
  execFileSync('git', ['clone', '-q', origin, mate]);
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  const store = new Store(initialState('room'));
  toasts = [];
  asked = [];
  mgr = new WorkspaceManager(wsStore);
  ctl = new WorkspaceController({
    manager: mgr,
    store,
    shares: new ShareService([]),
    selfId: () => 'me',
    toast: (t) => void toasts.push(t),
    intend: screenOver(store).intend,
    askClaude: (prompt, channel) => void asked.push({ prompt, channel }),
  });
  await ctl.refresh();
});

const pid = () => mgr.list.find((p) => p.root)!.id;
const project = () => mgr.list.find((p) => p.root)!;
const head = (dir: string, ref = 'HEAD') => git(dir, 'rev-parse', ref).trim();
const stashes = (dir: string) => git(dir, 'stash', 'list').trim();

describe('the default branch', () => {
  it('reports the main folder against origin/main as of the last fetch', async () => {
    teammatePushes({ 0: 'from mate' }, 'mate 1');
    let line = await defaultBranch(repo, 'origin/main');
    expect(line).toMatchObject({ branch: 'main', upstream: 'origin/main', remote: 'origin', local: true, ahead: 0, behind: 0, onDefault: true, current: 'main', dirty: 0 });
    await ctl.mainSync.fetch(pid());
    line = await defaultBranch(repo, 'origin/main');
    expect(line.behind).toBe(1);
    expect(line.fetchedAt).toBeGreaterThan(Date.now() - 60_000);
    // The published project carries it, for the home's header.
    expect(project().sync).toMatchObject({ branch: 'main', behind: 1, onDefault: true });
  });

  it('learns a remote’s default branch (master) when origin/HEAD isn’t set', async () => {
    const other = path.join(base, 'old.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'master', other]);
    const dir = path.join(base, 'old');
    git(base, 'init', '-q', '-b', 'master', dir);
    writeFileSync(path.join(dir, 'a'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');
    git(dir, 'remote', 'add', 'origin', other);
    git(dir, 'push', '-q', '-u', 'origin', 'master');
    const fetched = await fetchRemote(dir);
    expect(fetched.ok).toBe(true);
    // Newer git sets origin/HEAD while fetching; older git: Beluga asks the remote (ls-remote --symref).
    const learned = fetched.ok && fetched.remoteDefault ? `origin/${fetched.remoteDefault}` : await defaultBase(dir);
    expect(learned).toBe('origin/master');
    expect(parseSymref('ref: refs/heads/trunk\tHEAD\nabc123\tHEAD\n')).toBe('trunk');
    expect(parseSymref('abc\tHEAD')).toBeUndefined();
  });
});

describe('Update main', () => {
  it('fetches and fast-forwards a clean main, and says how many commits came in', async () => {
    teammatePushes({ 0: 'a' }, 'mate 1');
    teammatePushes({ 1: 'b' }, 'mate 2');
    const outcome = await ctl.mainSync.update(pid());
    expect(outcome).toEqual({ kind: 'updated', branch: 'main', upstream: 'origin/main', commits: 2 });
    expect(head(repo)).toBe(head(mate));
    expect(toasts).toContain('main is up to date (2 new commits)');
    expect(project().sync).toMatchObject({ behind: 0, ahead: 0 });
    expect(await ctl.mainSync.update(pid())).toMatchObject({ kind: 'up_to_date' });
  });

  it('fast-forwards past uncommitted changes the new commits don’t touch', async () => {
    teammatePushes({ 0: 'a' }, 'mate 1');
    writeFileSync(path.join(repo, 'mine.txt'), 'scratch\n');
    expect(await ctl.mainSync.update(pid())).toMatchObject({ kind: 'updated', commits: 1 });
    expect(readFileSync(path.join(repo, 'mine.txt'), 'utf8')).toBe('scratch\n');
  });

  it('changes in the way: stash, update, and put them back (untracked files too)', async () => {
    teammatePushes({ 0: 'from mate' }, 'mate 1');
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 11: 'mine' }));
    writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    const blocked = await ctl.mainSync.update(pid());
    expect(blocked).toMatchObject({ kind: 'dirty', files: ['notes.txt'], behind: 1 });
    expect(head(repo)).not.toBe(head(mate));
    const out = await ctl.mainSync.stashAndUpdate(pid());
    expect(out).toMatchObject({ kind: 'updated', commits: 1, restored: true });
    expect(readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe(fileWith({ 0: 'from mate', 11: 'mine' }));
    expect(existsSync(path.join(repo, 'new.txt'))).toBe(true);
    expect(stashes(repo)).toBe('');
    expect(toasts.at(-1)).toBe('main is up to date (1 new commit) · your changes are back');
  });

  it('when putting them back conflicts, keeps the stash and says so', async () => {
    teammatePushes({ 4: 'theirs' }, 'mate 1');
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 4: 'mine' }));
    const out = await ctl.mainSync.stashAndUpdate(pid());
    expect(out).toMatchObject({ kind: 'updated', restored: false, conflicts: ['notes.txt'] });
    expect(out.stash?.message).toMatch(/^beluga: before updating main/);
    expect(stashes(repo)).toContain('beluga: before updating main');
    expect(head(repo)).toBe(head(mate));
  });

  it('never touches someone else’s stash entry (finds its own by message)', async () => {
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 2: 'x' }));
    const mine = await stashPush(repo, 'test');
    expect(mine?.message).toMatch(/^beluga: test/);
    expect(mine?.sha).toBe(head(repo, 'refs/stash'));
    expect(await stashPush(repo, 'nothing left')).toBeUndefined();
  });

  it('or moves the changes to a new worktree, then updates the clean main', async () => {
    teammatePushes({ 0: 'from mate' }, 'mate 1');
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 0: 'mine' }));
    writeFileSync(path.join(repo, 'draft.md'), 'draft\n');
    const before = head(repo);
    const { wsId, outcome } = await ctl.mainSync.moveAndUpdate(pid(), 'my-changes');
    expect(outcome).toMatchObject({ kind: 'updated', commits: 1 });
    const ws = mgr.find(wsId)!;
    expect(ws.kind).toBe('worktree');
    expect(ws.branch).toBe('beluga/my-changes');
    expect(head(ws.path)).toBe(before);
    expect(readFileSync(path.join(ws.path, 'notes.txt'), 'utf8')).toBe(fileWith({ 0: 'mine' }));
    expect(existsSync(path.join(ws.path, 'draft.md'))).toBe(true);
    expect(await dirtyFiles(repo)).toEqual([]);
    expect(head(repo)).toBe(head(mate));
    expect(stashes(repo)).toBe('');
  });

  it('diverged (local commits and new ones on origin): offers Claude, doesn’t touch anything', async () => {
    teammatePushes({ 0: 'a' }, 'mate 1');
    writeFileSync(path.join(repo, 'local.txt'), 'local\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'local commit');
    const before = head(repo);
    expect(await ctl.mainSync.update(pid())).toEqual({ kind: 'diverged', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1 });
    expect(head(repo)).toBe(before);
  });

  it('a merge stopped halfway: busy, for Claude', async () => {
    teammatePushes({ 3: 'theirs' }, 'mate 1');
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 3: 'mine' }));
    git(repo, 'commit', '-qam', 'mine');
    git(repo, 'fetch', '-q');
    expect(() => git(repo, 'merge', 'origin/main')).toThrow();
    expect(await updateDefault(repo, 'origin/main', { fetch: false })).toEqual({ kind: 'busy', operation: 'merge' });
  });

  it('a remote that wants a sign-in fails quietly with a clear message (no prompt)', async () => {
    const pack = path.join(base, 'needs-auth.sh');
    writeFileSync(pack, "#!/bin/sh\necho \"remote: Invalid username or password.\" >&2\necho \"fatal: Authentication failed for 'https://github.com/kay/app.git/'\" >&2\nexit 128\n");
    chmodSync(pack, 0o755);
    git(repo, 'config', 'remote.origin.uploadpack', pack);
    const quiet = await ctl.mainSync.fetch(pid(), { quiet: true });
    expect(quiet).toMatchObject({ ok: false, reason: 'auth' });
    expect(toasts).toEqual([]);
    expect(project().sync?.fetchError).toMatchObject({ reason: 'auth', message: expect.stringMatching(/sign in/) });
    const update = await ctl.mainSync.update(pid());
    expect(update).toMatchObject({ kind: 'fetch_failed', reason: 'auth' });
    expect(toasts.at(-1)).toMatch(/never asks for passwords/);
    // The background pass leaves it alone for a while after that.
    await ctl.mainSync.backgroundPass();
    expect(await ctl.mainSync.fetchIfStale(pid())).toBeUndefined();
  });
});

describe('fetch errors in words', () => {
  it.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['ERROR: Repository not found.', 'auth'],
    ["fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com", 'offline'],
    ['ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.', 'offline'],
    ["fatal: 'upstream' does not appear to be a git repository", 'no_remote'],
    ['fatal: something else entirely', 'other'],
  ])('%s → %s', (raw, reason) => {
    expect(classifyFetchError(raw).reason).toBe(reason);
  });

  it('lists the files in the way', () => {
    expect(filesInTheWay('error: Your local changes to the following files would be overwritten by merge:\n\tnotes.txt\n\tsrc/a.ts\nPlease commit your changes or stash them before you merge.')).toEqual(['notes.txt', 'src/a.ts']);
  });
});

describe('the main folder on another branch', () => {
  beforeEach(async () => {
    git(repo, 'switch', '-q', '-c', 'feat/panel');
    writeFileSync(path.join(repo, 'feat.txt'), 'feat\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feature work');
    await ctl.refresh();
  });

  it('the header is about main, and says where the folder is', async () => {
    expect(project().sync).toMatchObject({ branch: 'main', onDefault: false, current: 'feat/panel', ahead: 0, behind: 0 });
    expect(describeLine(project().sync!)).toMatch(/the main folder is on feat\/panel, not main/);
  });

  it('Update main moves main itself without touching the folder', async () => {
    teammatePushes({ 0: 'a' }, 'mate 1');
    const featHead = head(repo);
    expect(await ctl.mainSync.update(pid())).toMatchObject({ kind: 'updated', commits: 1 });
    expect(head(repo, 'refs/heads/main')).toBe(head(mate));
    expect(head(repo)).toBe(featHead);
  });

  it('Switch to main: clean switches; changes in the way are refused, then carried or moved', async () => {
    writeFileSync(path.join(repo, 'feat.txt'), 'edited\n');
    expect(await ctl.mainSync.switchToDefault(pid(), 'clean')).toMatchObject({ kind: 'dirty', files: ['feat.txt'] });
    const moved = await ctl.mainSync.switchToDefault(pid(), 'move');
    expect(moved.kind).toBe('switched');
    const ws = mgr.find(moved.wsId!)!;
    expect(ws.branch).toBe('feat/panel');
    expect(readFileSync(path.join(ws.path, 'feat.txt'), 'utf8')).toBe('edited\n');
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
    expect(await dirtyFiles(repo)).toEqual([]);
    expect(project().sync).toMatchObject({ onDefault: true });
  });

  it('a clean folder just switches back', async () => {
    expect(await ctl.mainSync.switchToDefault(pid(), 'clean')).toEqual({ kind: 'switched', branch: 'main' });
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
  });
});

describe('Let Claude handle it', () => {
  it('diverged history: a worktree from local main, where Claude can work', async () => {
    teammatePushes({ 0: 'a' }, 'mate 1');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'local');
    await ctl.mainSync.fetch(pid());
    const wsId = await ctl.mainSync.askClaude(pid(), 'main and origin/main have both moved on');
    const ws = mgr.find(wsId!)!;
    expect(ws).toMatchObject({ kind: 'worktree', purpose: 'sync_main', name: 'update-main' });
    expect(ws.askOnly).toBeFalsy();
    // Its branch starts from local main, so the local commit comes along.
    expect(head(ws.path)).toBe(head(repo, 'main'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.channel).toBe(`ws:${wsId}`);
    expect(asked[0]!.prompt).toMatch(/Bring main up to date with origin\/main/);
    expect(asked[0]!.prompt).toMatch(/main and origin\/main have both moved on \(main has 1 commit that isn’t on origin\/main, and origin\/main has 1 new commit/);
    expect(asked[0]!.prompt).toMatch(/main is checked out in the main folder, so don't move it yourself/);
    expect(asked[0]!.prompt).toMatch(/Never push/);
    const place = ctl.place(`ws:${wsId}`);
    expect(place?.askOnly).toBeUndefined();
    expect(place?.autoEdit).toBe(true);
    // The main folder isn't touched.
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
  });

  it('a failing fetch: a worktree from origin, told git’s words and never to handle a password', async () => {
    git(repo, 'remote', 'set-url', 'origin', path.join(base, 'gone.git'));
    const out = await ctl.mainSync.update(pid());
    expect(out.kind).toBe('fetch_failed');
    const wsId = await ctl.mainSync.askClaude(pid(), `Couldn’t fetch: ${out.kind === 'fetch_failed' ? out.message : ''}`);
    expect(mgr.find(wsId!)).toMatchObject({ kind: 'worktree', purpose: 'sync_main' });
    expect(asked[0]!.prompt).toMatch(/What Beluga found: Couldn’t fetch/);
    expect(asked[0]!.prompt).toMatch(/If fetching fails, find out why/);
    expect(asked[0]!.prompt).toMatch(/Never ask for, type or store a password or token/);
  });

  it('a merge stopped halfway in main: a main-folder conversation whose next run (only) may sync git', async () => {
    teammatePushes({ 0: 'theirs' }, 'mate 1');
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 0: 'ours' }));
    git(repo, 'commit', '-q', '-am', 'local');
    await ctl.mainSync.fetch(pid());
    expect(() => git(repo, 'merge', 'origin/main')).toThrow();
    const wsId = await ctl.mainSync.askClaude(pid());
    const ws = mgr.find(wsId!)!;
    expect(ws).toMatchObject({ kind: 'chat', askOnly: true, purpose: 'sync_main', name: 'Update main' });
    expect(asked[0]!.prompt).toMatch(/a merge is stopped halfway in the main folder/);
    expect(asked[0]!.prompt).toMatch(/Never push/);
    const first = ctl.place(`ws:${wsId}`);
    expect(first?.askOnly).toBeTruthy();
    expect(first?.syncMain).toEqual({ branch: 'main', upstream: 'origin/main' });
    // A follow-up question later is questions-only again.
    expect(ctl.place(`ws:${wsId}`)?.syncMain).toBeUndefined();
  });
});

describe('one change to main at a time', () => {
  it('refuses a second update while one runs, and never drops someone else’s stash entry', async () => {
    teammatePushes({ 0: 'a' }, 'mate 1');
    const [first, second] = await Promise.allSettled([ctl.mainSync.update(pid()), ctl.mainSync.update(pid())]);
    expect(first).toMatchObject({ status: 'fulfilled', value: { kind: 'updated' } });
    expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/already updating/) }) });
    // Someone else's entry above ours stays where it is when ours is dropped.
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 3: 'ours' }));
    const ours = (await stashPush(repo, 'ours'))!;
    writeFileSync(path.join(repo, 'notes.txt'), fileWith({ 5: 'theirs' }));
    git(repo, 'stash', 'push', '-q', '-m', 'someone else');
    await stashDrop(repo, ours.sha);
    expect(git(repo, 'stash', 'list', '--format=%gs').trim()).toBe('On main: someone else');
  });

  it('won’t leave commits no branch holds when switching a detached main folder', async () => {
    git(repo, 'switch', '-q', '--detach');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'orphan');
    await ctl.refresh();
    expect(await ctl.mainSync.switchToDefault(pid(), 'clean')).toMatchObject({ kind: 'failed', message: expect.stringMatching(/no branch holds/) });
  });
});
