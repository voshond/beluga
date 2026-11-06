import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectDir } from '../src/agent/runtime/claude/claude-sessions.js';
import { WorkspaceManager, mainId, projectId } from '../src/workspaces/manager.js';
import { defaultProjectsHome } from '../src/workspaces/new-project.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let base: string;
let repo: string;
let store: WorkspaceStore;
let manager: WorkspaceManager;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-move-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  repo = path.join(base, 'Projects', 'app');
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(base, 'GitHub'));
  sh(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'Projects')], projects: [], hidden: [], groups: [{ name: 'Work', projects: [repo] }], order: [repo], scripts: { [repo]: { setup: 'npm ci' } } });
  manager = new WorkspaceManager(store);
  await manager.refresh();
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe('moveProject', () => {
  it('moves the folder and keeps the id, its worktrees, chats and config', async () => {
    const id = projectId(repo);
    const wt = await manager.createWorktree(id, 'feature');
    const chat = await manager.createChat(id, 'question');
    const sessions = path.join(base, 'claude', 'projects', encodeProjectDir(repo));
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, 's1.jsonl'), '{}\n');

    const res = await manager.moveProject(id, path.join(base, 'GitHub'));
    const to = path.join(base, 'GitHub', 'app');

    expect(res).toEqual({ from: repo, to });
    expect(existsSync(repo)).toBe(false);
    expect(existsSync(path.join(to, 'a.txt'))).toBe(true);
    const project = manager.list.find((p) => p.root === to);
    expect(project?.id).toBe(id);
    expect(projectId(to)).toBe(id);
    expect(mainId(to)).toBe(`${id}:main`);
    expect(project?.workspaces.some((w) => w.id === wt.id && !w.archived)).toBe(true);
    expect(project?.workspaces.find((w) => w.id === chat.id)?.path).toBe(to);
    expect(sh(wt.path, 'status', '--porcelain')).toBe('');
    expect(realpathSync(sh(wt.path, 'rev-parse', '--git-common-dir').trim())).toBe(path.join(to, '.git'));

    const saved = store.loadConfig();
    expect(saved.projects).toContain(to);
    expect(saved.groups?.[0]?.projects).toEqual([to]);
    expect(saved.order).toEqual([to]);
    expect(Object.keys(saved.scripts ?? {})).toEqual([to]);
    expect(saved.ids).toEqual({ [to]: id });
    expect(store.loadRecords().every((r) => r.projectRoot !== repo)).toBe(true);
    expect(readFileSync(path.join(base, 'claude', 'projects', encodeProjectDir(to), 's1.jsonl'), 'utf8')).toBe('{}\n');
    expect(existsSync(path.join(sessions, 's1.jsonl'))).toBe(true);
  });

  it('keeps the id across a restart and a second move', async () => {
    const id = projectId(repo);
    await manager.moveProject(id, path.join(base, 'GitHub'));
    mkdirSync(path.join(base, 'Other'));
    const again = new WorkspaceManager(store);
    await again.refresh();
    await again.moveProject(id, path.join(base, 'Other'));
    const to = path.join(base, 'Other', 'app');
    expect(again.list.find((p) => p.root === to)?.id).toBe(id);
    expect(store.loadConfig().ids).toEqual({ [to]: id });
  });

  it('refuses a folder that is in the way, missing, or inside itself', async () => {
    const id = projectId(repo);
    mkdirSync(path.join(base, 'GitHub', 'app'));
    await expect(manager.moveProject(id, path.join(base, 'GitHub'))).rejects.toThrow(/already there/);
    await expect(manager.moveProject(id, path.join(base, 'nope'))).rejects.toThrow(/isn't there/);
    await expect(manager.moveProject(id, path.join(base, 'Projects'))).rejects.toThrow(/already in/);
    mkdirSync(path.join(repo, 'sub'));
    await expect(manager.moveProject(id, path.join(repo, 'sub'))).rejects.toThrow(/inside itself/);
    expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
  });
});

describe('defaultProjectsHome', () => {
  it('takes the folder you chose when it is there, else the first code folder found', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-home-'));
    mkdirSync(path.join(home, 'Documents', 'GitHub'), { recursive: true });
    expect(defaultProjectsHome(home)).toBe(path.join(home, 'Documents', 'GitHub'));
    mkdirSync(path.join(home, 'code'));
    expect(defaultProjectsHome(home)).toBe(path.join(home, 'code'));
    expect(defaultProjectsHome(home, path.join(home, 'Documents', 'GitHub'))).toBe(path.join(home, 'Documents', 'GitHub'));
    expect(defaultProjectsHome(home, path.join(home, 'gone'))).toBe(path.join(home, 'code'));
  });
});
