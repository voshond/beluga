import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMainCheckout } from '../src/workspaces/discovery.js';
import { badProjectName, createProject, defaultProjectsHome, initProject } from '../src/workspaces/new-project.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-new-project-'));
const gitOut = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('starting a new project', () => {
  it('makes the folder, git on main and a first commit with a README', async () => {
    const parent = tmp();
    const dir = await createProject('  my-app ', parent);
    expect(dir).toBe(path.join(parent, 'my-app'));
    expect(isMainCheckout(dir)).toBe(true);
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# my-app\n');
    expect(gitOut(dir, 'branch', '--show-current')).toBe('main');
    expect(gitOut(dir, 'log', '--format=%s')).toBe('Start my-app');
  });

  it('uses an empty folder that is already there, and refuses one with files', async () => {
    const parent = tmp();
    mkdirSync(path.join(parent, 'empty'));
    await expect(createProject('empty', parent)).resolves.toBe(path.join(parent, 'empty'));
    mkdirSync(path.join(parent, 'full'));
    writeFileSync(path.join(parent, 'full', 'notes.txt'), 'hi');
    await expect(createProject('full', parent)).rejects.toThrow(/already there/);
    expect(existsSync(path.join(parent, 'full', '.git'))).toBe(false);
  });

  it('refuses names that are not one folder', async () => {
    expect(badProjectName('')).toBeDefined();
    expect(badProjectName('a/b')).toBeDefined();
    expect(badProjectName('..')).toBeDefined();
    expect(badProjectName('.hidden')).toBeDefined();
    expect(badProjectName('My App')).toBeUndefined();
    await expect(createProject('../escape', tmp())).rejects.toThrow();
  });

  it('puts new projects in the code folder you already have', () => {
    const home = tmp();
    expect(defaultProjectsHome(home)).toBe(path.join(home, 'Projects'));
    mkdirSync(path.join(home, 'Developer'));
    expect(defaultProjectsHome(home)).toBe(path.join(home, 'Developer'));
  });
});

describe('making a folder that is already there a project', () => {
  it('commits what is in it on main, with a .gitignore that keeps node_modules and .env files out', async () => {
    const dir = path.join(tmp(), 'site');
    mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
    writeFileSync(path.join(dir, '.env'), 'KEY=1');
    writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), '');
    await expect(initProject(dir)).resolves.toBe(dir);
    expect(isMainCheckout(dir)).toBe(true);
    expect(gitOut(dir, 'branch', '--show-current')).toBe('main');
    expect(gitOut(dir, 'log', '--format=%s')).toBe('Start site');
    expect(gitOut(dir, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'index.html']);
  });

  it('keeps a .gitignore of its own, and gives an empty folder a README', async () => {
    const own = tmp();
    writeFileSync(path.join(own, '.gitignore'), 'out/\n');
    writeFileSync(path.join(own, 'a.txt'), 'a');
    await initProject(own);
    expect(readFileSync(path.join(own, '.gitignore'), 'utf8')).toBe('out/\n');
    const empty = tmp();
    await initProject(empty);
    expect(gitOut(empty, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'README.md']);
  });

  it('refuses a git project, a missing folder, and your home folder or the disk', async () => {
    const repo = tmp();
    await initProject(repo);
    await expect(initProject(repo)).rejects.toThrow(/already a git project/);
    await expect(initProject(path.join(tmp(), 'nope'))).rejects.toThrow(/isn't there/);
    await expect(initProject(os.homedir())).rejects.toThrow(/too big/);
    await expect(initProject(path.parse(os.homedir()).root)).rejects.toThrow(/too big/);
  });
});
