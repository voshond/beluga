import os from 'node:os';
import path from 'node:path';
import type { IPty } from '../terminal/pty.js';
import { childEnv, defaultShell, spawnPty } from '../terminal/pty.js';
import type { Store } from './store.js';
import { RUN_ASK_MAX_OUTPUT, RUN_ASK_TIMEOUT_MS, type RunAskState, type RunTarget, plainOutput, promptIn, runAnswer, runTarget, runnableQuestion, scrubbed, tail } from './run-ask.js';

export type RunAskSpawn = (file: string, args: readonly string[], cwd: string) => IPty;

export type RunAsksDeps = {
  readonly store: Store;
  readonly selfId: () => string;
  readonly sshHosts: () => Promise<readonly string[]>;
  readonly answer: (qid: string, question: string, text: string) => void;
  readonly hostname?: () => string;
  readonly spawn?: RunAskSpawn;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

type Running = {
  readonly pty: IPty;
  readonly question: string;
  readonly expect?: string;
  readonly secrets: string[];
  readonly timer: NodeJS.Timeout;
  readonly intro: string;
  raw: string;
  state: RunAskState;
  flush?: NodeJS.Timeout;
  ended: boolean;
};

const FLUSH_MS = 120;
const POSIX_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

const scriptOf = (commands: readonly string[]): string => ['set -e', ...commands].join('\n');

const localShell = (): string => {
  const shell = defaultShell();
  return POSIX_SHELLS.has(path.basename(shell)) ? shell : '/bin/sh';
};

const withoutPrompt = (state: RunAskState): RunAskState => {
  const { prompt: _prompt, ...rest } = state;
  return rest;
};

const defaultSpawn: RunAskSpawn = (file, args, cwd) => spawnPty({ file, args, cwd, env: childEnv(), cols: 120, rows: 30 });

export class RunAsks {
  private readonly running = new Map<string, Running>();

  constructor(private readonly deps: RunAsksDeps) {}

  async start(qid: string, question: string): Promise<void> {
    if (this.running.has(qid)) return;
    const q = this.deps.store.getState().questions.find((x) => x.qid === qid);
    if (!q) throw new Error('That question isn’t waiting any more');
    const run = runnableQuestion(q, this.deps.selfId(), question);
    if (!run) throw new Error('Only your own agent’s commands, in one sh block, can run from here');
    const hostname = this.deps.hostname?.() ?? os.hostname();
    const target = runTarget(run.on, hostname, run.on ? await this.deps.sshHosts() : []);
    if (!target) throw new Error(`Beluga can’t reach “${run.on}” from here: give it a Host in your SSH config, or copy the commands instead`);
    if (this.running.has(qid)) return;
    this.launch(qid, question, target, scriptOf(run.commands), run.expect);
  }

  input(qid: string, text: string): void {
    const run = this.running.get(qid);
    if (!run || run.ended) return;
    if (run.state.prompt?.secret) run.secrets.push(text);
    run.pty.write(`${text}\r`);
    this.update(qid, run, withoutPrompt(run.state));
  }

  stop(qid: string): void {
    const run = this.running.get(qid);
    if (!run) return;
    this.finish(qid, run, { status: 'stopped' });
    run.pty.kill();
  }

  stopAll(): void {
    for (const qid of [...this.running.keys()]) this.stop(qid);
  }

  private launch(qid: string, question: string, target: RunTarget, script: string, expect?: string): void {
    const spawn = this.deps.spawn ?? defaultSpawn;
    const [file, args] = target.kind === 'local' ? [localShell(), ['-lc', script]] : ['ssh', ['-t', target.host, script]];
    const startedAt = this.deps.now?.() ?? Date.now();
    const intro = target.kind === 'ssh' ? `$ ssh ${shQuote(target.host)}\n` : '';
    const state: RunAskState = { status: 'running', where: target.where, output: intro, startedAt };
    let pty: IPty;
    try {
      pty = spawn(file, args, os.homedir());
    } catch (err) {
      this.deps.store.dispatch({ type: 'run_ask', qid, state: { ...state, status: 'failed', error: err instanceof Error ? err.message : String(err) } });
      return;
    }
    const timer = setTimeout(() => {
      const run = this.running.get(qid);
      if (!run) return;
      this.finish(qid, run, { status: 'failed', error: `it was still running after ${Math.round((this.deps.timeoutMs ?? RUN_ASK_TIMEOUT_MS) / 60_000)} minutes, so Beluga stopped it` });
      run.pty.kill();
    }, this.deps.timeoutMs ?? RUN_ASK_TIMEOUT_MS);
    timer.unref();
    const run: Running = { pty, question, ...(expect ? { expect } : {}), secrets: [], timer, intro, raw: '', state, ended: false };
    this.running.set(qid, run);
    this.deps.store.dispatch({ type: 'run_ask', qid, state });
    pty.onData((data) => this.onData(qid, run, data));
    pty.onExit(({ exitCode }) => {
      if (run.ended) return;
      this.finish(qid, run, { status: exitCode === 0 ? 'done' : 'failed', exit: exitCode });
    });
  }

  private onData(qid: string, run: Running, data: string): void {
    if (run.ended) return;
    if (!this.deps.store.getState().questions.some((q) => q.qid === qid)) {
      this.finish(qid, run, { status: 'stopped' }, false);
      run.pty.kill();
      return;
    }
    run.raw = tail(run.raw + data, RUN_ASK_MAX_OUTPUT * 2);
    const output = this.outputOf(run);
    const prompt = promptIn(output);
    if (prompt) return this.update(qid, run, { ...run.state, output, prompt });
    run.state = { ...withoutPrompt(run.state), output };
    if (run.flush) return;
    run.flush = setTimeout(() => {
      run.flush = undefined;
      if (!run.ended) this.update(qid, run, run.state);
    }, FLUSH_MS);
  }

  private outputOf(run: Running): string {
    return tail(scrubbed(run.intro + plainOutput(run.raw), run.secrets), RUN_ASK_MAX_OUTPUT);
  }

  private update(qid: string, run: Running, state: RunAskState): void {
    run.state = state;
    this.deps.store.dispatch({ type: 'run_ask', qid, state });
  }

  private finish(qid: string, run: Running, end: Pick<RunAskState, 'status'> & Partial<Pick<RunAskState, 'exit' | 'error'>>, answer = true): void {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.timer);
    if (run.flush) clearTimeout(run.flush);
    this.running.delete(qid);
    const state: RunAskState = { ...withoutPrompt(run.state), output: this.outputOf(run), ...end };
    if (!answer || !this.deps.store.getState().questions.some((q) => q.qid === qid)) return;
    this.deps.store.dispatch({ type: 'run_ask', qid, state });
    if (state.status === 'stopped') return;
    this.deps.answer(qid, run.question, runAnswer(state, run.expect));
  }
}
