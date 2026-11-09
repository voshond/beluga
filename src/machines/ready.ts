import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../core/session.js';
import { cloneableOrigin, githubSlug, repoName, sameRepo } from '../shared/repo-key.js';
import { posixSh } from '../terminal/pty.js';
import { git } from '../workspaces/git.js';
import { ghStatus } from './info.js';
import {
  type InstallPlan,
  NEED_FILES,
  type PackageManager,
  type ReadyPlatform,
  type ReadyRun,
  type ReadySystem,
  type StepId,
  type Tool,
  VERSION_COMMANDS,
  cloneTarget,
  cloneTrouble,
  firstSteps,
  installPlan,
  missingOf,
  needsOf,
  projectsFolder,
  systemNote,
  toolWords,
  versionIn,
  withStep,
} from './ready-model.js';

/**
 * Getting this computer ready for a project (BLG-787), run here on the computer's own system with
 * its own git, gh and tools: the projects folder, a clone (gh's sign-in when it has one), the tools
 * the project's files ask for (named, and installed only once you say so: a user-level way first),
 * then its setup worked out for this system and kept here. Your app follows each step
 * (machines.ready.status) and shows it on the new worktree.
 */

export interface ReadyDeps {
  /** This computer's name (for "Getting build-box ready"). */
  readonly name: () => string;
  readonly home: string;
  readonly platform: ReadyPlatform;
  /** One command in a login shell here (nvm loaded, ~/.local/bin on the PATH). */
  readonly sh: (command: string, opts?: { readonly cwd?: string; readonly timeoutMs?: number }) => Promise<{ readonly code: number; readonly out: string }>;
  readonly isDir: (dir: string) => boolean;
  readonly mkdir: (dir: string) => void;
  readonly readFile: (file: string) => string | undefined;
  readonly projects: () => ReadonlyArray<{ readonly id: string; readonly name: string; readonly root: string }>;
  readonly origin: (root: string) => Promise<string | undefined>;
  readonly addProject: (dir: string) => Promise<{ readonly id: string } | { readonly error: string }>;
  /** Its setup worked out for this system and kept here → the command (none: it needs none). */
  readonly workOutSetup: (projectId: string, system: string) => Promise<string | undefined>;
  readonly gh: () => Promise<'signed_in' | 'signed_out' | 'missing'>;
  readonly system: () => Promise<ReadySystem>;
  /** The projects folder set here (none: the usual one). */
  readonly projectsFolder?: () => string | undefined;
}

const CLONE_MS = 15 * 60_000;
const INSTALL_MS = 15 * 60_000;
const SETUP_MS = 20 * 60_000;
const KEEP_RUNS = 20;

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export class Readying {
  private readonly runs = new Map<string, ReadyRun>();
  /** A run's work in flight (one at a time per run). */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: ReadyDeps) {}

  /** Get the project at `origin` ready here → the run, to follow with status(). */
  start(origin: string, name?: string): ReadyRun {
    if (!cloneableOrigin(origin)) throw new Error('That isn’t a git address Beluga can clone');
    // Already getting it ready: the same run.
    const going = [...this.runs.values()].find((r) => sameRepo(r.origin, origin) && (r.state === 'running' || r.state === 'asking'));
    if (going) return going;
    const project = name?.trim() || repoName(origin) || 'project';
    const run: ReadyRun = { id: randomUUID(), computer: this.deps.name(), project, origin, state: 'running', steps: firstSteps(project) };
    this.set(run);
    this.go(run.id, () => this.prepare(run.id));
    return run;
  }

  status(id: string): ReadyRun | undefined {
    return this.runs.get(id);
  }

  /** You said yes: install what's missing (the user-level way where there is one), then go on. */
  install(id: string): ReadyRun {
    const run = this.runs.get(id);
    if (!run) throw new Error('That isn’t being made ready here any more');
    if (run.state !== 'asking') return run;
    this.set({ ...withStep(run, 'tools', { state: 'active', detail: 'Installing…' }), state: 'running' });
    this.go(id, () => this.installMissing(id));
    return this.runs.get(id)!;
  }

  private go(id: string, work: () => Promise<void>): void {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    void work()
      .catch((err: unknown) => this.fail(id, this.runs.get(id)?.steps.find((s) => s.state === 'active')?.id ?? 'setup', err instanceof Error ? err.message : String(err)))
      .finally(() => this.busy.delete(id));
  }

  private set(run: ReadyRun): void {
    this.runs.delete(run.id);
    this.runs.set(run.id, run);
    while (this.runs.size > KEEP_RUNS) this.runs.delete(this.runs.keys().next().value!);
  }

  private step(id: string, step: StepId, patch: Parameters<typeof withStep>[2]): ReadyRun {
    const next = withStep(this.runs.get(id)!, step, patch);
    this.set(next);
    return next;
  }

  private fail(id: string, step: StepId, error: string, fix?: { words: string; command?: string }): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.set({ ...withStep(run, step, { state: 'failed', error, ...(fix ? { fix } : {}) }), state: 'failed' });
  }

  /** The folder and the clone (or the project already here), then the tools. */
  private async prepare(id: string): Promise<void> {
    const run = this.runs.get(id)!;
    const here = await this.findHere(run.origin);
    if (here) {
      this.step(id, 'folder', { state: 'skipped', detail: 'Already here' });
      this.set({ ...this.step(id, 'clone', { state: 'skipped', label: `${run.project} is here`, detail: here.root }), projectId: here.id, path: here.root });
      return this.checkTools(id);
    }
    // The folder.
    this.step(id, 'folder', { state: 'active' });
    const folder = projectsFolder(this.deps.platform, this.deps.home, this.deps.isDir, this.deps.projectsFolder?.());
    try {
      this.deps.mkdir(folder);
    } catch (err) {
      return this.fail(id, 'folder', `Couldn’t make ${folder} on ${run.computer}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.step(id, 'folder', { state: 'done', detail: folder.replace(this.deps.home, '~') });
    // The clone: with gh's sign-in for GitHub when it has one, else git's own.
    const target = cloneTarget(folder, repoName(run.origin) ?? run.project, (dir) => this.deps.isDir(dir));
    this.step(id, 'clone', { state: 'active', detail: target.replace(this.deps.home, '~') });
    const gh = await this.deps.gh().catch(() => 'missing' as const);
    const slug = githubSlug(run.origin);
    const command = slug && gh === 'signed_in' ? `gh repo clone ${q(slug)} ${q(target)}` : `GIT_TERMINAL_PROMPT=0 git clone ${q(run.origin)} ${q(target)}`;
    const cloned = await this.deps.sh(command, { cwd: folder, timeoutMs: CLONE_MS });
    if (cloned.code !== 0) {
      const trouble = cloneTrouble(cloned.out, run.computer, gh);
      return this.fail(id, 'clone', trouble.words, trouble.fix);
    }
    const added = await this.deps.addProject(target);
    if ('error' in added) return this.fail(id, 'clone', `${run.project} was cloned to ${target}, but couldn’t be added: ${added.error}`);
    this.set({ ...this.step(id, 'clone', { state: 'done' }), projectId: added.id, path: target });
    return this.checkTools(id);
  }

  /** A project of yours here already, by its origin. */
  private async findHere(origin: string): Promise<{ id: string; root: string } | undefined> {
    for (const p of this.deps.projects()) {
      if (!p.root) continue;
      const at = await this.deps.origin(p.root).catch(() => undefined);
      if (at && sameRepo(at, origin)) return p;
    }
    return undefined;
  }

  /** What the project's files ask for, against what's here: on to setup, or asking you to install what's missing. */
  private async checkTools(id: string): Promise<void> {
    const run = this.runs.get(id)!;
    this.step(id, 'tools', { state: 'active' });
    const root = run.path!;
    // The computer's own paths, written with / as its projects folder is (Windows takes both).
    const files = Object.fromEntries(NEED_FILES.map((f) => [f, this.deps.readFile(`${root}/${f}`)]));
    const needs = needsOf(files);
    const have = await this.versions(needs.map((n) => n.tool));
    const missing = missingOf(needs, have);
    const label = needs.length ? needs.map((n) => toolWords(n)).join(', ') : 'Tools it needs';
    if (!missing.length) {
      this.step(id, 'tools', { state: needs.length ? 'done' : 'skipped', label, detail: needs.length ? 'All here' : 'Nothing to install' });
      return this.setup(id);
    }
    const sys = await this.deps.system();
    const plans = missing.map((m) => installPlan(m, sys));
    const missingWords = missing.map((m) => m.words).join(', ');
    this.set({ ...this.step(id, 'tools', { state: 'asking', label, detail: `Missing on ${run.computer}: ${missingWords}` }), state: 'asking', missing: plans });
  }

  private async versions(tools: readonly Tool[]): Promise<Partial<Record<Tool, string>>> {
    const found = await Promise.all(tools.map(async (t) => {
      const r = await this.deps.sh(VERSION_COMMANDS[t], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: '' }));
      return [t, r.code === 0 ? versionIn(r.out) : undefined] as const;
    }));
    return Object.fromEntries(found.filter(([, v]) => v !== undefined));
  }

  private async installMissing(id: string): Promise<void> {
    const run = this.runs.get(id)!;
    for (const plan of run.missing ?? []) {
      if (!plan.can) return this.fail(id, 'tools', plan.why ?? `${plan.words} can’t be installed from here`, plan.command ? { words: 'Run it there', command: plan.command } : undefined);
      this.step(id, 'tools', { state: 'active', detail: `Installing ${plan.words}…` });
      const done = await this.deps.sh(plan.command!, { cwd: run.path, timeoutMs: INSTALL_MS });
      if (done.code !== 0) return this.fail(id, 'tools', installTrouble(plan, done.out, run.computer), { words: 'Run it there', command: plan.command! });
    }
    const { missing: _gone, ...rest } = this.runs.get(id)!;
    this.set(rest);
    return this.checkTools(id);
  }

  /** The setup new worktrees run here, worked out for this system and kept on this computer. */
  private async setup(id: string): Promise<void> {
    const run = this.runs.get(id)!;
    this.step(id, 'setup', { state: 'active', label: 'Working out its setup' });
    const sys = await this.deps.system();
    const command = await this.deps.workOutSetup(run.projectId!, systemNote(sys));
    if (!command) {
      this.set({ ...this.step(id, 'setup', { state: 'skipped', label: 'No setup needed' }), state: 'done' });
      return;
    }
    // Run once in its folder, with the tools just checked (it runs again in each new worktree there).
    this.step(id, 'setup', { state: 'active', label: `Setup: ${command}`, detail: 'Running…' });
    const ran = await this.deps.sh(command, { cwd: run.path!, timeoutMs: SETUP_MS });
    if (ran.code !== 0) {
      const last = ran.out.trim().split('\n').filter(Boolean).pop();
      return this.fail(id, 'setup', `${command} failed on ${run.computer}${last ? `: ${last.slice(0, 200)}` : ''}`, { words: 'Run it there', command });
    }
    this.set({ ...this.step(id, 'setup', { state: 'done', detail: 'Runs in each new worktree here too' }), state: 'done', setup: command });
  }
}

/** An installer's failure, in plain words. */
function installTrouble(plan: InstallPlan, output: string, computer: string): string {
  if (/sudo: a password is required|a terminal is required/i.test(output)) return `${plan.words} needs an administrator on ${computer}`;
  if (/could not resolve host|network is unreachable|timed out/i.test(output)) return `${computer} can’t download ${plan.words} right now`;
  const last = output.trim().split('\n').filter(Boolean).pop();
  return `Installing ${plan.words} failed on ${computer}${last ? `: ${last.slice(0, 200)}` : ''}`;
}

// ---- this computer, for real

const PATHS = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/go/bin:$PATH"; [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1;';

/**
 * The user's own environment for a command: Beluga's process's, less what npm set for Beluga itself
 * (npm_config_prefix and the rest, when it was started through npm): nvm refuses to run with them
 * (seen on a real run, BLG-842), and they'd point the user's npm at Beluga's.
 */
export function userEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/^npm_/i.test(k)) out[k] = v;
  return { ...out, HOME: home, GIT_TERMINAL_PROMPT: '0' };
}

/**
 * One command in a login shell for the user at `home` (nvm loaded, ~/.local/bin on the PATH): bash,
 * and on Windows Git for Windows' bash (never WSL's, which a bare `bash` there can be).
 */
function shAt(home: string): ReadyDeps['sh'] {
  const bash = process.platform === 'win32' ? posixSh() : 'bash';
  return (command, opts = {}) =>
    new Promise((resolve) => {
      if (!bash) return resolve({ code: 127, out: 'Getting ready needs Git for Windows (its bash): install it from git-scm.com, or set CLAUDE_CODE_GIT_BASH_PATH' });
      execFile(bash, ['-lc', `${PATHS} ${command}`], { cwd: opts.cwd ?? home, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024, env: userEnv(process.env, home) }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}`.slice(-20_000) });
      });
    });
}

const platformHere = (): ReadyPlatform => (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux');

/** What this computer's system offers the user at `home`. */
async function detectSystem(home: string, sh: ReadyDeps['sh']): Promise<ReadySystem> {
  const platform = platformHere();
  const has = async (cmd: string): Promise<boolean> => (await sh(`command -v ${cmd} >/dev/null`)).code === 0;
  const pkg: PackageManager | undefined = (await has('brew')) ? 'brew' : (await has('apt-get')) ? 'apt' : (await has('dnf')) ? 'dnf' : (await has('apk')) ? 'apk' : undefined;
  const release =
    platform === 'macos'
      ? `macOS ${(await sh('sw_vers -productVersion')).out.trim()}`
      : /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readText('/etc/os-release') ?? '')?.[1];
  // Only sudo that never asks for a password counts (sudo -n); none at all is fine.
  const sudo = platform !== 'macos' && (await sh('sudo -n true')).code === 0;
  return { platform, ...(release ? { release } : {}), ...(pkg ? { pkg } : {}), sudo, nvm: existsSync(path.join(home, '.nvm', 'nvm.sh')) };
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * This computer's own system for the user at `home` (BLG-842: the tests run it for real with a
 * temporary home): the shell, files, gh and what the system offers. The rest (projects, setup)
 * is the daemon's.
 */
export function hostReadyDeps(home = os.homedir()): Pick<ReadyDeps, 'home' | 'platform' | 'sh' | 'isDir' | 'mkdir' | 'readFile' | 'origin' | 'gh' | 'system'> {
  const sh = shAt(home);
  let system: Promise<ReadySystem> | undefined;
  return {
    home,
    platform: platformHere(),
    sh,
    isDir,
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    // A lockfile can be huge: only its being there counts, so a big file reads as empty.
    readFile: (file) => {
      const size = fileSize(file);
      return size === undefined ? undefined : size > MAX_READ ? '' : readText(file);
    },
    origin: (root) => git(root, ['remote', 'get-url', 'origin'], 5_000).then((o) => o.trim() || undefined),
    gh: ghStatus,
    // Asked once: after an install, what's there is asked of the shell again, not of this.
    system: () => (system ??= detectSystem(home, sh)),
  };
}

/** The real readiness of a session's computer. */
export function realReadyDeps(s: Session, name: () => string): ReadyDeps {
  return {
    ...hostReadyDeps(),
    name,
    projects: () => s.store.getState().projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    addProject: async (dir) => {
      const added = await s.workspaces?.addProject(dir);
      return added?.project ? { id: added.project.id } : { error: added?.error ?? 'Beluga isn’t ready to add projects here' };
    },
    workOutSetup: async (projectId, system) => s.workbench?.workOutFor(projectId, system),
  };
}

const MAX_READ = 256 * 1024;

/** A file's size (none: not a file there). */
function fileSize(file: string): number | undefined {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

const sessions = new WeakMap<Session, Readying>();

/** This session's readiness runs (made on first use). */
export function readyingOf(s: Session, name: () => string = () => os.hostname()): Readying {
  let r = sessions.get(s);
  if (!r) sessions.set(s, (r = new Readying(realReadyDeps(s, name))));
  return r;
}
