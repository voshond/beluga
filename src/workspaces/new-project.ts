import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceError } from './manager.js';
import { git, tryGit } from './git.js';

/** Where new projects go unless you pick somewhere: the first of these that exists, else ~/Projects. */
const HOMES = ['Projects', 'projects', 'Developer', 'code', 'Code', 'dev', 'repos', 'GitHub'];

export function defaultProjectsHome(home = os.homedir()): string {
  for (const rel of HOMES) {
    const dir = path.join(home, rel);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // not this one
    }
  }
  return path.join(home, 'Projects');
}

/** Why a project name won't do as a folder name, or undefined when it's fine. */
export function badProjectName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (n.length > 100) return 'That name is too long';
  if (n === '.' || n === '..' || n.startsWith('.')) return "A name can't start with a dot";
  if (/[/\\:\0]/.test(n)) return "A name can't have / \\ or : in it";
  return undefined;
}

const isEmptyDir = (dir: string): boolean => readdirSync(dir).every((f) => f === '.DS_Store');

/** What a folder made into a project leaves out of git when it has no .gitignore of its own (.env files still reach worktrees: env.ts copies them). */
const GITIGNORE = ['.DS_Store', 'node_modules/', '.env', '.env.*', '!.env.example', ''].join('\n');

/** Git won't commit without a name and email: borrow the Mac's user name when none is set. */
async function author(dir: string): Promise<string[]> {
  if ((await tryGit(dir, ['config', 'user.email']))?.trim()) return [];
  const me = os.userInfo().username;
  return ['-c', `user.name=${me}`, '-c', `user.email=${me}@localhost`];
}

/**
 * Make a folder a git project where it is: git on `main`, a .gitignore when it has none, a README
 * when it's empty, and what's in it in a first commit, so worktrees can branch from it straight away.
 * Your home folder and the disk itself are refused. When it fails, nothing it made is left behind.
 */
export async function initProject(dir: string): Promise<string> {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new WorkspaceError(`${abs} isn't there`);
  // Home, or a folder holding it (the disk too): from there home is inside, not up and out.
  const toHome = path.relative(abs, os.homedir());
  if (!toHome.startsWith('..') && !path.isAbsolute(toHome)) {
    throw new WorkspaceError(`${abs} is too big to be one project. Pick the folder of the project itself.`);
  }
  if (existsSync(path.join(abs, '.git'))) throw new WorkspaceError(`${path.basename(abs)} is already a git project`);
  const name = path.basename(abs);
  const wrote = [
    ...(existsSync(path.join(abs, '.gitignore')) ? [] : [{ file: '.gitignore', text: GITIGNORE }]),
    ...(isEmptyDir(abs) ? [{ file: 'README.md', text: `# ${name}\n` }] : []),
  ];
  try {
    await git(abs, ['init', '--initial-branch=main']);
    for (const w of wrote) writeFileSync(path.join(abs, w.file), w.text);
    await git(abs, ['add', '-A']);
    await git(abs, [...(await author(abs)), 'commit', '-m', `Start ${name}`], 120_000);
  } catch (e) {
    rmSync(path.join(abs, '.git'), { recursive: true, force: true });
    for (const w of wrote) rmSync(path.join(abs, w.file), { force: true });
    throw e;
  }
  return abs;
}

/**
 * Start a new project: a folder `name` in `parent` (your code folder unless you pick one), git on
 * `main` with a README in a first commit, so worktrees can branch from it straight away.
 * An empty folder that's already there is used; one with files in it is refused.
 */
export async function createProject(name: string, parent?: string): Promise<string> {
  const bad = badProjectName(name);
  if (bad) throw new WorkspaceError(bad);
  const n = name.trim();
  const dir = path.resolve(parent || defaultProjectsHome(), n);
  const existed = existsSync(dir);
  if (existed && (!statSync(dir).isDirectory() || !isEmptyDir(dir))) throw new WorkspaceError(`${dir} is already there, with files in it. Add it as a project instead.`);
  mkdirSync(dir, { recursive: true });
  try {
    await git(dir, ['init', '--initial-branch=main']);
    writeFileSync(path.join(dir, 'README.md'), `# ${n}\n`);
    await git(dir, ['add', 'README.md']);
    await git(dir, [...(await author(dir)), 'commit', '-m', `Start ${n}`]);
  } catch (e) {
    // Leave nothing half-made behind (but never a folder that was there before).
    if (!existed) rmSync(dir, { recursive: true, force: true });
    else rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    throw e;
  }
  return dir;
}
