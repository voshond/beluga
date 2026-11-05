import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString().trim();

let base: string;
let repo: string;
let mgr: WorkspaceManager;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-wt-rename-')));
  const origin = path.join(base, 'app.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', origin);
  sh(repo, 'push', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', 'main');
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  mgr = new WorkspaceManager(store);
  await mgr.refresh();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const project = () => mgr.list.find((p) => p.root)!;
const headOf = (dir: string) => sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

describe('renaming a worktree (BLG-722)', () => {
  it('renames its label and its own branch; the folder stays', async () => {
    const ws = await mgr.createWorktree(project().id, 'quick-name');
    const done = await mgr.renameByUser(ws.id, 'Login fix');
    expect(done).toEqual({ name: 'login-fix', branch: 'beluga/login-fix' });
    expect(mgr.find(ws.id)).toMatchObject({ name: 'login-fix', branch: 'beluga/login-fix', path: ws.path, nameSetByUser: true });
    expect(headOf(ws.path)).toBe('beluga/login-fix');
    // Still the same after reading git again.
    await mgr.refresh();
    expect(mgr.find(ws.id)?.branch).toBe('beluga/login-fix');
  });

  it('takes exactly the branch typed with a / in it, and refuses one git would not', async () => {
    const ws = await mgr.createWorktree(project().id, 'quick-name');
    expect(await mgr.renameByUser(ws.id, 'feat/BLG-12-login')).toEqual({ name: 'blg-12-login', branch: 'feat/BLG-12-login' });
    expect(headOf(ws.path)).toBe('feat/BLG-12-login');
    await expect(mgr.renameByUser(ws.id, 'feat/bad..name')).rejects.toThrow(/can’t be a branch name/);
    sh(repo, 'branch', 'feat/taken');
    await expect(mgr.renameByUser(ws.id, 'feat/taken')).rejects.toThrow(/is there already/);
    expect(mgr.find(ws.id)).toMatchObject({ name: 'blg-12-login', branch: 'feat/BLG-12-login' });
  });

  it('keeps a branch of yours in its folder, and finds a free name when one is taken', async () => {
    sh(repo, 'branch', 'beluga/report');
    const ws = await mgr.createWorktree(project().id, 'quick-name');
    expect((await mgr.renameByUser(ws.id, 'report')).branch).toBe('beluga/report-2');
    // Renamed to what it already is: it keeps its -2, not a -3.
    expect((await mgr.renameByUser(ws.id, 'report')).branch).toBe('beluga/report-2');

    sh(repo, 'branch', 'feature/old', 'main');
    const yours = await mgr.createWorktreeOn(project().id, 'old', 'feature/old');
    expect(await mgr.renameByUser(yours.id, 'new')).toEqual({ name: 'new', branch: 'feature/new' });
    expect(headOf(yours.path)).toBe('feature/new');
  });

  it('leaves a pushed branch alone: only the label changes', async () => {
    const ws = await mgr.createWorktree(project().id, 'shipped');
    sh(ws.path, 'push', '-u', 'origin', 'beluga/shipped');
    expect(await mgr.renameByUser(ws.id, 'better name')).toEqual({ name: 'better-name', branch: 'beluga/shipped', branchKept: 'pushed' });
    expect(headOf(ws.path)).toBe('beluga/shipped');
  });

  it('keeps your name against the one the model gives later', async () => {
    const ws = await mgr.createWorktree(project().id, 'quick-name');
    await mgr.renameByUser(ws.id, 'mine');
    await mgr.renameWorktree(ws.id, 'model name');
    expect(mgr.find(ws.id)).toMatchObject({ name: 'mine', branch: 'beluga/mine' });
  });

  it('refuses a name with nothing to make a branch of', async () => {
    const ws = await mgr.createWorktree(project().id, 'quick-name');
    await expect(mgr.renameByUser(ws.id, '!!!')).rejects.toThrow(/letter or a digit/);
    expect(mgr.find(ws.id)).toMatchObject({ name: 'quick-name', branch: 'beluga/quick-name' });
  });
});
