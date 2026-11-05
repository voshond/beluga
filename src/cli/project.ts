import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../core/home-path.js';
import type { Intent } from '../core/intents.js';
import type { SocketClient } from '../ipc/socket-client.js';
import type { Project } from '../workspaces/types.js';
import type { ScriptSource } from '../workspaces/scripts.js';
import { type Exit, type Io, errorText } from './io.js';
import { tilde } from './paths.js';

/** What `beluga project` needs from the daemon. */
export interface ProjectLink {
  projects(): readonly Project[];
  onChange(listener: () => void): () => void;
  /** A git project, or a folder of them (projects.add). */
  add(dir: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  /** Where new projects go (projects.newHome): the same folder the Mac app picks. */
  home(): Promise<string>;
  /** What the daemon said while doing it: its warnings and errors (toasts). */
  onProblem(listener: (text: string) => void): () => void;
}

/** Projects with a folder: not Chats (the conversations outside any project, listed as one). */
export const realProjects = (projects: readonly Project[]): readonly Project[] => projects.filter((p) => p.root);

export function projectLinkOf(client: SocketClient): ProjectLink {
  return {
    projects: () => realProjects(client.store.getDomain().projects),
    onChange: (l) => client.store.subscribe(l),
    add: (dir) => client.call('projects.add', dir),
    remove: (id) => client.call('workspaces.removeProject', id),
    home: () => client.call('projects.newHome'),
    onProblem: (l) => client.onIntent((i: Intent) => void (i.type === 'toast' && i.level !== 'success' && i.level !== 'info' ? l(i.text) : undefined)),
  };
}

/** A git URL (https, ssh, git@host:owner/repo, file://), not a folder. */
export const isGitUrl = (s: string): boolean => /^(https?|ssh|git|file):\/\//.test(s) || /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(s);

/** The folder a clone of this URL gets: its last part, without .git. */
export function cloneName(url: string): string {
  const last = url.replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
  return last.replace(/\.git$/, '') || 'project';
}

const SOURCE_WORDS: Readonly<Record<ScriptSource, string>> = {
  yours: 'you set it',
  claude: 'Claude worked it out',
  'beluga.json': 'from beluga.json',
  'klaud.json': 'from klaud.json',
  'conductor.json': 'from conductor.json',
  detected: 'found from its files',
};

/** What a new worktree of this project runs first, in words. */
export function setupWords(p: Project): string {
  const setup = p.scripts?.setup;
  return setup ? `New worktrees run \`${setup.command}\` first (${SOURCE_WORDS[setup.source] ?? setup.source}).` : 'No setup command found: new worktrees start as they are.';
}

/** `git clone` into `dest`, its progress shown on this terminal. */
export function gitClone(url: string, dest: string, io: Io): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--', url, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (d: Buffer): void => io.err(d.toString());
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (err) => reject(new Error(`git isn't installed here (${err.message}); install it, then try again`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone stopped (exit ${code})`))));
  });
}

/** Resolves once the projects match `ready`, or undefined after `ms`. */
function until<T>(link: ProjectLink, ready: (ps: readonly Project[]) => T | undefined, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const now = ready(link.projects());
    if (now) return resolve(now);
    const timer = setTimeout(() => (off(), resolve(undefined)), ms);
    const off = link.onChange(() => {
      const r = ready(link.projects());
      if (!r) return;
      clearTimeout(timer);
      off();
      resolve(r);
    });
  });
}

/** A folder as the daemon keeps it: through its symlinks (/tmp is /private/tmp on a Mac), BLG-676. */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const inside = (root: string, dir: string): boolean => root === dir || root.startsWith(dir + path.sep);

export interface AddOptions {
  /** Where a clone goes (default: the projects folder the app uses). */
  readonly into?: string;
  readonly cwd?: string;
  readonly clone?: (url: string, dest: string, io: Io) => Promise<void>;
  readonly waitMs?: number;
}

/** `beluga project add <folder or git URL>`. */
export async function addProject(link: ProjectLink, target: string | undefined, io: Io, opts: AddOptions = {}): Promise<Exit> {
  if (!target) {
    io.err('Add what? `beluga project add <folder>` or `beluga project add <git URL>`.\n');
    return 2;
  }
  let dir: string;
  if (isGitUrl(target)) {
    const parent = path.resolve(opts.cwd ?? process.cwd(), expandHome(opts.into ?? (await link.home())));
    dir = path.join(parent, cloneName(target));
    if (existsSync(path.join(dir, '.git'))) io.err(`${tilde(dir)} is already there; adding it as it is.\n`);
    else if (existsSync(dir)) {
      io.err(`${tilde(dir)} already exists and isn't a git checkout. Move it, or clone somewhere else with --into <folder>.\n`);
      return 1;
    } else {
      io.err(`Cloning ${target} into ${tilde(dir)}…\n`);
      try {
        await (opts.clone ?? gitClone)(target, dir, io);
      } catch (err) {
        io.err(`Couldn't clone it: ${errorText(err)}.\n`);
        return 1;
      }
    }
  } else {
    dir = path.resolve(opts.cwd ?? process.cwd(), expandHome(target));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      io.err(`There's no folder at ${tilde(dir)}. To clone one instead, give its git URL.\n`);
      return 1;
    }
  }
  dir = real(dir);
  const before = new Set(link.projects().map((p) => p.root));
  const problems: string[] = [];
  const off = link.onProblem((t) => problems.push(t));
  try {
    await link.add(dir);
  } catch (err) {
    problems.push(errorText(err));
  } finally {
    off();
  }
  const added = await until(link, (ps) => {
    const found = ps.filter((p) => inside(p.root, dir));
    return found.length ? found : undefined;
  }, problems.length ? 500 : (opts.waitMs ?? 10_000));
  if (!added) {
    const why = (problems[0] ?? `Beluga didn't add ${tilde(dir)}`).replace(/\.$/, '');
    io.err(`${why}.\nA project is a git checkout: run \`git init\` in it (or give a folder with some inside), then add it again.\n`);
    return 1;
  }
  const fresh = added.filter((p) => !before.has(p.root));
  if (added.length === 1) {
    const p = added[0]!;
    io.out(`${fresh.length ? 'Added' : 'Already added:'} ${p.name} (${tilde(p.root)}).\n${setupWords(p)}\nThe phone can start a worktree in it now.\n`);
  } else {
    io.out(`Watching ${tilde(dir)}: ${added.length} projects in it (${added.map((p) => p.name).join(', ')}). New ones there show up too.\n`);
  }
  return 0;
}

/** `beluga project list`. */
export function listProjects(all: readonly Project[], io: Io): Exit {
  const projects = realProjects(all);
  if (!projects.length) {
    io.out('No projects yet. Add one with `beluga project add <folder or git URL>`.\n');
    return 0;
  }
  const width = Math.max(...projects.map((p) => p.name.length));
  for (const p of projects) {
    const worktrees = p.workspaces.filter((w) => w.kind !== 'main' && !w.archived).length;
    const setup = p.scripts?.setup ? `setup: ${p.scripts.setup.command}` : 'no setup command';
    io.out(`  ${p.name.padEnd(width)}  ${tilde(p.root)}  (${worktrees} worktree${worktrees === 1 ? '' : 's'}, ${setup})${p.error ? `  can't open: ${p.error}` : ''}\n`);
  }
  return 0;
}

/** The project a name (any case), id or folder means; an error in plain words when none or several do. */
export function findProject(projects: readonly Project[], which: string, cwd = process.cwd()): Project | string {
  const abs = real(path.resolve(cwd, expandHome(which)));
  const exact = projects.find((p) => p.id === which || p.root === abs);
  if (exact) return exact;
  const named = projects.filter((p) => p.name.toLowerCase() === which.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `${named.length} projects are called “${which}”: give its folder instead (${named.map((p) => tilde(p.root)).join(', ')}).`;
  return projects.length ? `No project is called “${which}”. Projects: ${projects.map((p) => p.name).join(', ')}.` : 'There are no projects yet.';
}

/** `beluga project remove <name>`: out of Beluga; its folder stays, its worktrees are archived. */
export async function removeProject(link: ProjectLink, which: string | undefined, io: Io, waitMs = 10_000): Promise<Exit> {
  if (!which) {
    io.err('Which project? `beluga project remove <name>` (`beluga project list` lists them).\n');
    return 2;
  }
  const p = findProject(link.projects(), which);
  if (typeof p === 'string') {
    io.err(`${p}\n`);
    return 1;
  }
  const ok = await link.remove(p.id).catch(() => false);
  if (ok === false || !(await until(link, (ps) => (ps.some((x) => x.id === p.id) ? undefined : true), waitMs))) {
    io.err(`Beluga didn't remove ${p.name}. \`beluga logs\` may say why.\n`);
    return 1;
  }
  io.out(`Removed ${p.name} from Beluga. Its folder stays at ${tilde(p.root)}, and its worktrees are archived.\n`);
  return 0;
}
