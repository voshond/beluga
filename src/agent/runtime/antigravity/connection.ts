import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { codexCommand, pathVar } from '../codex/app-server.js';
import { CodexRpc } from '../codex/rpc.js';
import type { InitializeResponse } from '../opencode/acp.js';
import { acpHandshake } from '../opencode/connection.js';

/** `agy acp` for one run (or one side call): its JSON-RPC, its process, what it said it can do. */
export interface AgyConnection {
  readonly rpc: CodexRpc;
  readonly proc: RunProcess;
  readonly init: InitializeResponse;
  /** Its last stderr lines, for a failure's details. */
  readonly stderr: () => readonly string[];
}

export interface AgyConnectOptions {
  readonly cwd: string;
  /** Its whole environment (the run's env over Beluga's). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The Antigravity CLI's own executable; unset: findAgy(). */
  readonly bin?: string;
  /** Flags for this process (its extra folders). */
  readonly args?: readonly string[];
  /**
   * A look, not a run (a status check, a quota read, a side call): nothing of it is yours to keep,
   * so its log (`acp-server-<time>-<pid>.log`) goes once it has stopped. A run's log stays.
   */
  readonly look?: boolean;
}

/** Where `agy acp` keeps its conversations: ~/.gemini/antigravity-cli. */
export function agyDataDir(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli');
}

/** Where it writes a log per process, named by its pid. */
export const agyLogDir = (dir: string = agyDataDir()): string => path.join(dir, 'log');

/** Removes one process's own log (only one named for its pid). */
export async function dropAgyLog(pid: number, dir: string = agyLogDir()): Promise<number> {
  const mine = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('acp-server-') && n.endsWith(`-${pid}.log`));
  await Promise.all(mine.map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => undefined)));
  return mine.length;
}

/** How a run reaches Antigravity: spawn it (tests hand a scripted one instead). */
export type AgyConnect = (opts: AgyConnectOptions) => Promise<AgyConnection>;

const STDERR_KEEP = 40;

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where the Antigravity CLI (`agy`) is: BELUGA_AGY_PATH, then `agy` on PATH, then its install
 * script's folder (~/.local/bin) and Homebrew's (the Mac app's PATH may not have them). On
 * Windows, agy.exe on PATH. Undefined: not installed.
 */
export function findAgy(env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable, home: string = os.homedir()): string | undefined {
  const set = env.BELUGA_AGY_PATH;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') return [...dirs, p.join(home, '.local', 'bin')].map((dir) => p.join(dir, 'agy.exe')).find(runs);
  const extra = [p.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...dirs, ...extra.filter((d) => !dirs.includes(d))].map((dir) => p.join(dir, 'agy')).find(runs);
}

export const AGY_MISSING_WORDS = (where = process.platform === 'darwin' ? 'Mac' : 'computer'): string => `The Antigravity CLI isn’t installed on this ${where}. Install it (curl -fsSL https://antigravity.google/cli/install.sh | bash), then try again.`;

/** Flags for a run: the folders it may work in besides its own (`--add-dir`, one each). */
export function agyArgs(opts: { readonly addDirs?: readonly string[] } = {}): string[] {
  return (opts.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]);
}

/** Spawn `agy acp` and shake hands. It signs in with what Antigravity already has (its keyring): never here. */
export const spawnAgy: AgyConnect = async ({ cwd, env, bin, args = [], look = false }) => {
  const command = bin ?? findAgy(env ?? process.env);
  if (!command) throw new Error(AGY_MISSING_WORDS());
  const how = codexCommand(command, ['acp', ...args]);
  const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell });
  const lines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once('spawn', () => resolve(undefined));
    child.once('error', resolve);
  });
  if (spawned || child.pid === undefined) throw new Error(`Couldn’t start Antigravity (${spawned?.message ?? 'no process'}).`);
  niceForWorktree(child.pid, env);
  const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
  const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
  const pid = child.pid;
  const proc: RunProcess = { pid, alive: () => running(child), kill: () => endProcess(child).then(() => void (look && dropAgyLog(pid))), exited };
  const rpc = new CodexRpc(child.stdout, child.stdin, { name: 'Antigravity', jsonrpc: true });
  try {
    const init = await acpHandshake(rpc);
    return { rpc, proc, init, stderr: () => lines };
  } catch (err) {
    await proc.kill();
    throw new Error(`Antigravity didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
  }
};
