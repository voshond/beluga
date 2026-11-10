import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../src/core/session.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { cloneProject } from '../src/workspaces/clone-project.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-clone-'));
const git = (dir: string, ...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }); };

afterEach(() => {
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
});

describe('cloning a project', () => {
  it('clones a GitHub remote into a usable checkout', async () => {
    const parent = tmp();
    const source = path.join(parent, 'source');
    mkdirSync(source);
    git(source, 'init');
    writeFileSync(path.join(source, 'README.md'), 'hello');
    git(source, 'add', 'README.md');
    git(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${source}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/example/repo.git';
    const target = path.join(parent, 'projects', 'clone');
    await expect(cloneProject('https://github.com/example/repo.git', target)).resolves.toBe(target);
    expect(readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('hello');
    git(target, 'worktree', 'add', '-b', 'task', path.join(parent, 'task'));
  });

  it('rejects invalid URLs and nonempty folders', async () => {
    const parent = tmp();
    await expect(cloneProject('https://example.com/repo', path.join(parent, 'clone'))).rejects.toThrow(/GitHub/);
    writeFileSync(path.join(parent, 'keep'), 'safe');
    await expect(cloneProject('git@github.com:example/repo.git', parent)).rejects.toThrow(/not empty/);
    expect(readFileSync(path.join(parent, 'keep'), 'utf8')).toBe('safe');
  });

  it('reports inaccessible repositories', async () => {
    const parent = tmp();
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${parent}/missing.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/example/missing.git';
    await expect(cloneProject('https://github.com/example/missing.git', path.join(parent, 'clone'))).rejects.toThrow(/Clone failed.*access/s);
  });
});

describe('projects.clone', () => {
  it('opens the project you already have of that repository, however its address is written', async () => {
    const mine = tmp();
    git(mine, 'init');
    git(mine, 'remote', 'add', 'origin', 'git@github.com:example/wiki.git');
    const added: string[] = [];
    const workspaces = { addProject: async (dir: string) => (added.push(dir), { project: { id: 'new-id' } }) };
    const store = { getState: () => ({ projects: [{ id: 'wiki-id', root: mine }] }) };
    const target = path.join(tmp(), 'wiki');
    const s = { workspaces, store } as unknown as Session;
    expect(await HANDLERS['projects.clone'](s, 'https://github.com/example/wiki', target)).toEqual({ id: 'wiki-id', path: mine, existed: true });
    expect(added).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });
});
