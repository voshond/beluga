import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attach } from '../src/cli/attach.js';
import type { Io } from '../src/cli/io.js';
import { tilde } from '../src/cli/paths.js';
import { addProject, cloneName, findProject, isGitUrl, listProjects, projectLinkOf, removeProject } from '../src/cli/project.js';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo, readDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import type { SocketClient } from '../src/ipc/socket-client.js';

const running: RunningDaemon[] = [];
const clients: SocketClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of running.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
});

function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-cli-project-')));
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A git project with a first commit; `lock`: a package-lock.json, so its setup can be worked out. */
function repo(dir: string, lock = true): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  if (lock) {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '1.0.0' }));
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: path.basename(dir), lockfileVersion: 3, packages: { '': { name: path.basename(dir) } } }));
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  return dir;
}

/** `beluga project` against a daemon running in this process. */
async function daemonLink() {
  const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true });
  running.push(d);
  const client = await attach(readDaemonInfo()!);
  clients.push(client);
  return projectLinkOf(client);
}

describe('beluga project', () => {
  it('adds a folder, says what new worktrees run first, lists it, and removes it (its folder stays)', async () => {
    const link = await daemonLink();
    const dir = repo(path.join(tmp(), 'shop'));
    const io = capture();
    expect(await addProject(link, dir, io)).toBe(0);
    expect(io.text()).toContain(`Added shop (${tilde(dir)})`);
    expect(io.text()).toMatch(/New worktrees run `npm (ci|install)[^`]*` first \(found from its files\)/);
    expect(io.text()).toContain('The phone can start a worktree in it now');

    const again = capture();
    expect(await addProject(link, dir, again)).toBe(0);
    expect(again.text()).toContain('Already added: shop');

    const list = capture();
    listProjects(link.projects(), list);
    expect(list.text()).toMatch(/shop +.*shop +\(0 worktrees, setup: npm/);

    const gone = capture();
    expect(await removeProject(link, 'SHOP', gone)).toBe(0);
    expect(gone.text()).toContain(`Removed shop from Beluga. Its folder stays at ${tilde(dir)}`);
    expect(link.projects().some((p) => p.root === dir)).toBe(false);
    expect(git(dir, 'log', '--oneline')).toContain('first');
  });

  it('adds a folder given through a symlink (/tmp on a Mac), and says so (BLG-676)', async () => {
    const link = await daemonLink();
    const dir = repo(path.join(tmp(), 'linked'));
    const via = path.join(tmp(), 'shortcut');
    symlinkSync(dir, via);
    const io = capture();
    expect(await addProject(link, via, io)).toBe(0);
    expect(io.text()).toContain(`Added linked (${tilde(dir)})`);
    expect(io.errors()).not.toContain("didn't add");
    // Removed by the same path.
    const gone = capture();
    expect(await removeProject(link, via, gone)).toBe(0);
    expect(gone.text()).toContain('Removed linked');
  });

  it('clones a git URL first, into the folder given', async () => {
    const link = await daemonLink();
    const origin = repo(path.join(tmp(), 'origin-src'), false);
    const bare = path.join(tmp(), 'tool.git');
    git(tmp(), 'clone', '-q', '--bare', origin, bare);
    const into = tmp();
    const io = capture();
    expect(await addProject(link, `file://${bare}`, io, { into })).toBe(0);
    expect(io.errors()).toContain(`Cloning file://${bare} into`);
    expect(io.text()).toContain(`Added tool (${tilde(path.join(into, 'tool'))})`);
    expect(io.text()).toContain('No setup command found');
    // Cloned already: added as it is.
    await removeProject(link, 'tool', capture());
    const again = capture();
    expect(await addProject(link, `file://${bare}`, again, { into })).toBe(0);
    expect(again.errors()).toContain('is already there');
  });

  it('watches a folder of projects', async () => {
    const link = await daemonLink();
    const code = tmp();
    repo(path.join(code, 'api'), false);
    repo(path.join(code, 'web'), false);
    const io = capture();
    expect(await addProject(link, code, io)).toBe(0);
    expect(io.text()).toMatch(/Watching .*: 2 projects in it \((api, web|web, api)\)/);
  });

  it('says plainly what is wrong, with what to do', async () => {
    const link = await daemonLink();
    const plain = tmp();
    const notGit = capture();
    expect(await addProject(link, plain, notGit)).toBe(1);
    expect(notGit.errors()).toContain("isn't a git project");
    expect(notGit.errors()).toContain('git init');
    const missing = capture();
    expect(await addProject(link, path.join(plain, 'nope'), missing)).toBe(1);
    expect(missing.errors()).toContain("There's no folder at");
    const none = capture();
    expect(await addProject(link, undefined, none)).toBe(2);
    const taken = tmp();
    mkdirSync(path.join(taken, 'tool'));
    const clash = capture();
    expect(await addProject(link, 'https://github.com/someone/tool.git', clash, { into: taken, clone: async () => undefined })).toBe(1);
    expect(clash.errors()).toContain("isn't a git checkout");
    const unknown = capture();
    expect(await removeProject(link, 'nope', unknown)).toBe(1);
    expect(await removeProject(link, undefined, unknown)).toBe(2);
    const empty = capture();
    listProjects([], empty);
    expect(empty.text()).toContain('beluga project add');
  });
});

describe('reading what was given', () => {
  it('tells git URLs from folders, and names the clone', () => {
    for (const url of ['https://github.com/kayraucklnc/beluga', 'git@github.com:kayraucklnc/beluga.git', 'ssh://git@host/x/y.git', 'file:///srv/git/x.git']) expect(isGitUrl(url)).toBe(true);
    for (const dir of ['~/code/x', './x', '/srv/x', 'x']) expect(isGitUrl(dir)).toBe(false);
    expect(cloneName('https://github.com/kayraucklnc/beluga.git')).toBe('beluga');
    expect(cloneName('git@github.com:kayraucklnc/site')).toBe('site');
    expect(cloneName('https://github.com/a/b/')).toBe('b');
    // A Windows folder in a file:// URL (BLG-728).
    expect(cloneName('file://C:\\Users\\me\\tool.git')).toBe('tool');
  });

  it('finds a project by name, id or folder', () => {
    // Roots as this system writes them (`D:\d\web` on Windows).
    const p = (id: string, name: string, root: string) => ({ id, name, root: path.resolve(root), base: 'main', workspaces: [] });
    const list = [p('1', 'api', '/c/api'), p('2', 'web', '/c/web'), p('3', 'web', '/d/web')];
    expect(findProject(list, 'API')).toMatchObject({ id: '1' });
    expect(findProject(list, path.resolve('/d/web'))).toMatchObject({ id: '3' });
    expect(findProject(list, 'web', '/c')).toMatchObject({ id: '2' });
    expect(findProject(list, 'web', '/elsewhere')).toMatch(/2 projects are called/);
    expect(findProject(list, 'x', '/elsewhere')).toMatch(/No project is called “x”/);
  });
});
