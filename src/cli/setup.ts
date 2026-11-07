import { looksLikeToken, readClaudeToken, saveClaudeToken } from './claude.js';
import { type Exit, type Io, errorText } from './io.js';
import { type PairLink, pair } from './pair.js';
import { type ProjectLink, addProject, realProjects } from './project.js';
import { Cancelled, type Prompter } from './prompt.js';

/** The daemon as setup uses it: its projects and phone pairing, then let go. */
export interface SetupLink {
  readonly projects: ProjectLink;
  readonly pair: PairLink;
  close(): void;
}

export interface SetupDeps {
  readonly prompt: Prompter;
  /** Resolves when Enter is pressed (skip a step that waits), until the signal says stop listening. */
  readonly untilEnter: (signal: AbortSignal) => Promise<void>;
  readonly claude: {
    /** Claude Code can run here as it is (signed in some way). */
    signedIn(): Promise<boolean>;
    /** Claude Code's own `setup-token` on this terminal → its exit code. */
    setupToken(): Promise<number>;
  };
  readonly name: { saved(): string | undefined; fallback(): string; save(name: string): void };
  readonly daemon: {
    running(): boolean;
    /** Start it, or stop and start it again (to pick up a new name or token) → whether it runs. */
    start(restart: boolean): Promise<boolean>;
    attach(): Promise<SetupLink>;
  };
  readonly service: { installed(): boolean; install(io: Io): Promise<Exit> };
  readonly env?: NodeJS.ProcessEnv;
  readonly tokenFile?: string;
  readonly tty: boolean;
  readonly columns?: number;
}

export interface SetupOptions {
  /** Take every default and ask nothing (scripts, cloud-init). */
  readonly yes: boolean;
  /** A first project to add (a folder or a git URL). */
  readonly project?: string;
}

const done = (io: Io, what: string): void => io.out(`  ✓ ${what}\n`);
const later = (io: Io, what: string): void => io.out(`  · ${what}\n`);
const step = (io: Io, n: number, title: string): void => io.out(`\n${n}. ${title}\n`);

/** Claude's sign-in: already there, a token from the environment, or `claude setup-token` and a paste. */
async function claudeStep(deps: SetupDeps, opts: SetupOptions, io: Io): Promise<{ changed: boolean; left?: string }> {
  const env = deps.env ?? process.env;
  if (readClaudeToken(deps.tokenFile)) {
    done(io, 'Claude is signed in (its token is kept for Beluga).');
    return { changed: false };
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN && looksLikeToken(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    saveClaudeToken(env.CLAUDE_CODE_OAUTH_TOKEN, deps.tokenFile);
    done(io, 'Claude is signed in with CLAUDE_CODE_OAUTH_TOKEN, kept for Beluga from now on.');
    return { changed: true };
  }
  if (await deps.claude.signedIn()) {
    done(io, 'Claude is signed in.');
    return { changed: false };
  }
  if (opts.yes) {
    later(io, 'Claude isn’t signed in yet: run `beluga setup` in a terminal, or set CLAUDE_CODE_OAUTH_TOKEN and run it again.');
    return { changed: false, left: 'sign in to Claude: `beluga setup`' };
  }
  io.out('Claude Code signs in with a link: open it on any device, sign in, and paste the code it gives back here.\nAt the end it shows a long token starting sk-ant-: copy it.\n\n');
  const code = await deps.claude.setupToken();
  if (code !== 0) {
    later(io, `Claude Code's sign-in didn't finish (exit ${code}). Run \`beluga setup\` again to retry.`);
    return { changed: false, left: 'sign in to Claude: `beluga setup`' };
  }
  const token = await deps.prompt.secret('\nPaste the token Claude Code just showed (it stays hidden):');
  if (!looksLikeToken(token)) {
    later(io, 'That doesn’t look like a Claude token (they start sk-ant-). Run `beluga setup` again to paste it.');
    return { changed: false, left: 'sign in to Claude: `beluga setup`' };
  }
  saveClaudeToken(token, deps.tokenFile);
  // This process too: what it checks and starts from here on is signed in.
  env.CLAUDE_CODE_OAUTH_TOKEN = token.trim();
  done(io, 'Claude is signed in. The token is kept for Beluga only (~/.beluga/claude-token, readable by you alone).');
  return { changed: true };
}

/** The name the phone shows for this computer. */
async function nameStep(deps: SetupDeps, opts: SetupOptions, io: Io): Promise<boolean> {
  const saved = deps.name.saved();
  if (saved) {
    done(io, `Your phone calls this computer “${saved}”.`);
    return false;
  }
  const name = opts.yes ? deps.name.fallback() : await deps.prompt.ask('What should your phone call this computer?', deps.name.fallback());
  deps.name.save(name);
  done(io, `Your phone will call this computer “${name}”.`);
  return true;
}

async function projectStep(link: SetupLink, deps: SetupDeps, opts: SetupOptions, io: Io): Promise<string | undefined> {
  const projects = realProjects(link.projects.projects());
  if (projects.length && !opts.project) {
    const names = projects.slice(0, 4).map((p) => p.name).join(', ');
    done(io, `Projects: ${names}${projects.length > 4 ? ` and ${projects.length - 4} more` : ''}.`);
    return undefined;
  }
  const target = opts.project ?? (opts.yes ? '' : await deps.prompt.ask('A first project: a folder here, or a git URL to clone (Enter to skip):'));
  if (!target) {
    later(io, 'No project yet.');
    return 'add a project: `beluga project add <folder or git URL>`';
  }
  const code = await addProject(link.projects, target, io);
  return code === 0 ? undefined : 'add a project: `beluga project add <folder or git URL>`';
}

async function phoneStep(link: SetupLink, deps: SetupDeps, opts: SetupOptions, io: Io): Promise<string | undefined> {
  const phones = link.pair.companion().devices;
  if (phones.length) {
    done(io, `Paired: ${phones.map((p) => p.name).join(', ')}.`);
    return undefined;
  }
  if (opts.yes) {
    later(io, 'No phone paired yet.');
    return 'pair your phone: `beluga pair`';
  }
  io.out('Install Beluga on your phone, then pair it with this code. Press Enter to skip and pair later.\n\n');
  const skip = new AbortController();
  const stopped = new AbortController();
  const listening = new AbortController();
  void deps.untilEnter(listening.signal).then(() => skip.abort(), () => undefined);
  // Ctrl+C while waiting for the phone: the pairing closes, and setup stops (as at any question).
  const onCtrlC = (): void => (stopped.abort(), skip.abort());
  process.once('SIGINT', onCtrlC);
  // Pair? needs the keyboard: Enter stops meaning "skip" once the phone has dialed in. The
  // question catches Ctrl+C itself; ours goes only after, so there's never a moment with none.
  const ask = (q: string): Promise<string> => {
    listening.abort();
    const asking = deps.prompt.ask(q);
    process.off('SIGINT', onCtrlC);
    return asking.catch((err: unknown) => {
      stopped.abort();
      throw err;
    });
  };
  try {
    const code = await pair(link.pair, io, { ask, signal: skip.signal, tty: deps.tty, ...(deps.columns ? { columns: deps.columns } : {}) });
    if (stopped.signal.aborted) throw new Cancelled();
    return code === 0 ? undefined : 'pair your phone: `beluga pair`';
  } finally {
    listening.abort();
    process.off('SIGINT', onCtrlC);
  }
}

async function serviceStep(deps: SetupDeps, opts: SetupOptions, io: Io): Promise<string | undefined> {
  if (deps.service.installed()) {
    done(io, 'It keeps running, and starts when this computer does.');
    return undefined;
  }
  if (!opts.yes && !(await deps.prompt.confirm('Keep Beluga running, and start it when this computer does?', true))) {
    later(io, 'It runs until this computer restarts.');
    return 'keep it running: `beluga service install`';
  }
  return (await deps.service.install(io)) === 0 ? undefined : 'keep it running: `beluga up` after a restart, or fix what it said and `beluga service install`';
}

/**
 * `beluga setup [--yes] [--project <folder or URL>]`: Claude's sign-in, the computer's name, a
 * first project, the phone, and keeping it running. What's done already is said, not asked again.
 */
export async function setup(deps: SetupDeps, opts: SetupOptions, io: Io): Promise<Exit> {
  io.out(`Setting up Beluga on this computer.${opts.yes ? '' : ' Enter takes what’s in [brackets].'}\n`);
  const left: string[] = [];
  let link: SetupLink | undefined;
  try {
    step(io, 1, 'Claude');
    const claude = await claudeStep(deps, opts, io);
    if (claude.left) left.push(claude.left);
    step(io, 2, 'This computer');
    const renamed = await nameStep(deps, opts, io);
    const restart = deps.daemon.running() && (renamed || claude.changed);
    if (restart || !deps.daemon.running()) {
      if (!(await deps.daemon.start(restart))) {
        io.err('Beluga didn’t start, so setup can’t go on. `beluga logs` says why.\n');
        return 1;
      }
    }
    done(io, restart ? 'Beluga restarted with that.' : 'Beluga is running.');
    link = await deps.daemon.attach();
    step(io, 3, 'A project');
    const project = await projectStep(link, deps, opts, io);
    if (project) left.push(project);
    step(io, 4, 'Your phone');
    const phone = await phoneStep(link, deps, opts, io);
    if (phone) left.push(phone);
    link.close();
    link = undefined;
    step(io, 5, 'Keep it running');
    const service = await serviceStep(deps, opts, io);
    if (service) left.push(service);
  } catch (err) {
    link?.close();
    if (err instanceof Cancelled) {
      io.err('\nSetup stopped. Run `beluga setup` again: it picks up where you left off.\n');
      return 130;
    }
    io.err(`\nSetup stopped: ${errorText(err)}. Run \`beluga setup\` again: it picks up where you left off.\n`);
    return 1;
  }
  io.out(left.length ? `\nAlmost there. Still to do:\n${left.map((l) => `  - ${l}`).join('\n')}\n` : '\nAll set. Open Beluga on your phone to start work in your projects.\n');
  io.out('`beluga status` shows how it is.\n');
  return 0;
}
