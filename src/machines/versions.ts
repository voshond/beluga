import { execFile, spawn } from 'node:child_process';
import { z } from 'zod';
import { belugaEnv } from '../core/beluga-env.js';
import { type DomainState, isRunning } from '../core/store.js';

/**
 * Versions and updates across your computers (BLG-777). Your app and each computer speak the app
 * protocol (IPC_VERSION); one on another version is still listed, read-only, and said in plain
 * words, with Update It where the computer is the older one. Update It runs `beluga update` there,
 * which restarts its Beluga: so it waits until nothing runs there (no agent working, no program in
 * a terminal), or says what runs and lets you choose, never killing work by surprise. Before your
 * app updates to a protocol a computer can't speak, the update sheet asks which computers it would
 * leave behind (`leftBehind`) and offers to update them first.
 */

/** How a computer's protocol compares with the app's. */
export type Skew = 'same' | 'older' | 'newer';

export const skewOf = (app: number, computer: number | undefined): Skew => (computer === undefined || computer === app ? 'same' : computer < app ? 'older' : 'newer');

/** The words for a computer on another version, and which side to update. */
export function skewWords(name: string, version: string | undefined, skew: Skew): { text: string; update: 'computer' | 'app' } | undefined {
  const v = version ? ` (${version})` : '';
  if (skew === 'older') return { text: `${name} runs an older Beluga${v}: Update It to work there again.`, update: 'computer' };
  if (skew === 'newer') return { text: `${name} runs a newer Beluga${v} than this app: update this app to work there.`, update: 'app' };
  return undefined;
}

/** How Update It goes: as soon as nothing runs there (or now, if you said so), or ask first. */
export const UPDATE_MODES = ['ask', 'when-idle', 'now'] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

/** What a computer answers to Update It. */
export const UpdateAnswer = z.object({
  state: z.enum(['updating', 'waiting', 'busy', 'unsupported', 'failed']),
  /** What runs there now ("2 agents working", "1 terminal running a program"). */
  running: z.array(z.string().max(80)).max(8).default([]),
  message: z.string().max(400),
});
export type UpdateAnswer = z.infer<typeof UpdateAnswer>;

/** What runs on this computer that an update would stop. */
export function runningHere(state: Pick<DomainState, 'log'>, busyTerminals: number): string[] {
  const agents = state.log.filter((l) => l.type === 'agent' && isRunning(l.status)).length;
  return [...(agents ? [`${agents} agent${agents === 1 ? '' : 's'} working`] : []), ...(busyTerminals ? [`${busyTerminals} terminal${busyTerminals === 1 ? '' : 's'} running a program`] : [])];
}

/** One line of `ps -A -o pid=,ppid=,pgid=,tpgid=`. */
export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly tpgid: number;
}

export function parsePs(text: string): Proc[] {
  return text.split('\n').flatMap((line) => {
    const f = line.trim().split(/\s+/).map(Number);
    return f.length >= 4 && f.slice(0, 4).every((n) => Number.isInteger(n)) ? [{ pid: f[0]!, ppid: f[1]!, pgid: f[2]!, tpgid: f[3]! }] : [];
  });
}

/**
 * Beluga's terminals running a program, as the Mac's update rules count them (update_rules.rs
 * `busy_terminals`): a terminal's shell whose terminal has another foreground group than its own.
 * A shell sitting at its prompt doesn't count.
 */
export function busyTerminals(procs: readonly Proc[], shells: readonly number[]): number {
  return procs.filter((p) => shells.includes(p.pid) && p.tpgid > 0 && p.tpgid !== p.pgid).length;
}

/** `ps` on this computer (none on Windows: every terminal that runs counts as busy there). */
export function psHere(): Promise<Proc[] | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tpgid='], { timeout: 5_000 }, (err, out) => resolve(err ? undefined : parsePs(String(out))));
  });
}

export interface UpdaterDeps {
  readonly state: () => Pick<DomainState, 'log'>;
  /** The pids of the shells in Beluga's terminals that still run. */
  readonly shells: () => readonly number[];
  readonly ps: () => Promise<readonly Proc[] | undefined>;
  /** Start `beluga update` (it restarts this Beluga); undefined where it can't (not the server install). */
  readonly run?: () => void;
  readonly name: () => string;
  /** How often a waiting update looks again. */
  readonly everyMs?: number;
  readonly log?: (line: string) => void;
}

/** Update It, on the computer: now, once nothing runs, or say what runs and ask. */
export class ComputerUpdater {
  private waiting?: NodeJS.Timeout;

  constructor(private readonly deps: UpdaterDeps) {}

  /** What runs here that an update would stop. */
  async running(): Promise<string[]> {
    const shells = this.deps.shells();
    const procs = shells.length ? await this.deps.ps() : [];
    // When it can't be told what runs in them, every terminal still open counts.
    const busy = procs ? busyTerminals(procs, shells) : shells.length;
    return runningHere(this.deps.state(), busy);
  }

  async request(mode: UpdateMode): Promise<UpdateAnswer> {
    const name = this.deps.name();
    if (!this.deps.run) return { state: 'unsupported', running: [], message: `${name} didn't get Beluga from the server install, so it can't update itself: update it there.` };
    const running = mode === 'now' ? [] : await this.running();
    if (!running.length) return this.go(name);
    if (mode === 'ask') return { state: 'busy', running, message: `${name} has ${running.join(' and ')}. Update when they're done, or now (that stops them)?` };
    this.wait();
    return { state: 'waiting', running, message: `${name} updates as soon as nothing runs there (now: ${running.join(', ')}).` };
  }

  stop(): void {
    clearInterval(this.waiting);
    this.waiting = undefined;
  }

  /** Look again every so often; update the first time nothing runs. */
  private wait(): void {
    if (this.waiting) return;
    this.waiting = setInterval(() => {
      void this.running().then((still) => {
        if (still.length || !this.waiting) return;
        this.stop();
        this.go(this.deps.name());
      });
    }, this.deps.everyMs ?? 30_000);
    this.waiting.unref();
  }

  private go(name: string): UpdateAnswer {
    this.stop();
    try {
      this.deps.log?.('machines: updating Beluga (Update It from your app)');
      this.deps.run!();
      return { state: 'updating', running: [], message: `${name} is updating; it's back in a minute.` };
    } catch (err) {
      return { state: 'failed', running: [], message: `${name} couldn't start its update: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

/** `beluga update` in the background, outliving this daemon (it restarts it); only for the server install. */
export function updateRunner(): (() => void) | undefined {
  const cli = process.argv[1];
  if (!belugaEnv('SERVER_ROOT') || !cli) return undefined;
  return () => spawn(process.execPath, [cli, 'update'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * The computers an app update to protocol `next` would leave unable to connect: those on an
 * older protocol than `next` (a newer one is the app's to catch up with).
 */
export function leftBehind<T extends { readonly ipc?: number }>(next: number | undefined, computers: readonly T[]): T[] {
  return next === undefined ? [] : computers.filter((c) => c.ipc !== undefined && c.ipc < next);
}
