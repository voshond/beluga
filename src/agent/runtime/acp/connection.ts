import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcess } from '../../types.js';
import { endProcess, keepLines, niceForWorktree } from '../claude/claude-process.js';
import { codexCommand, pathVar } from '../codex/app-server.js';
import { CodexRpc } from '../codex/rpc.js';
import { acpHandshake } from '../opencode/connection.js';
import type { AcpExtension } from './extension.js';
import type { AcpAgentSpec, AcpConnect } from './spec.js';

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
 * Where an ACP agent's executable is: its variable (`pathVar`) outright, then PATH, then its own
 * folders (`searchDirs`: the Mac app's PATH may not have them). On Windows, its `.exe`. Undefined:
 * not installed.
 */
export function findAcpCommand(spec: Pick<AcpAgentSpec, 'command' | 'pathVar' | 'searchDirs'>, env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform, runs: (file: string) => boolean = executable, home: string = os.homedir()): string | undefined {
  const set = spec.pathVar ? env[spec.pathVar] : undefined;
  if (set) return runs(set) ? set : undefined;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar(env).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extra = (spec.searchDirs?.(platform, home) ?? []).filter((d) => !dirs.includes(d));
  const name = platform === 'win32' ? `${spec.command}.exe` : spec.command;
  return [...dirs, ...extra].map((dir) => p.join(dir, name)).find(runs);
}

/** Flags for a run: the folders it may work in besides its own (its `addDirFlag`, one each). */
export function addDirArgs(spec: Pick<AcpAgentSpec, 'addDirFlag'>, dirs: readonly string[]): string[] {
  const flag = spec.addDirFlag;
  return flag ? dirs.flatMap((dir) => [flag, dir]) : [];
}

/** Spawn an ACP agent's server and shake hands. It signs in with what it already has: never here. */
export function spawnAcp(spec: AcpAgentSpec, hooks: Pick<AcpExtension, 'afterLook'> = {}): AcpConnect {
  return async ({ cwd, env, bin, args = [], look = false }) => {
    const command = bin ?? findAcpCommand(spec, env ?? process.env);
    if (!command) throw new Error(spec.missingWords(process.platform === 'darwin' ? 'Mac' : 'computer'));
    const how = codexCommand(command, [...spec.args, ...args]);
    const child = spawn(how.command, [...how.args], { cwd, env: { ...(env ?? process.env), ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: how.shell });
    const lines: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => keepLines(lines, chunk, STDERR_KEEP));
    const spawned = await new Promise<Error | undefined>((resolve) => {
      child.once('spawn', () => resolve(undefined));
      child.once('error', resolve);
    });
    if (spawned || child.pid === undefined) throw new Error(`Couldn’t start ${spec.label} (${spawned?.message ?? 'no process'}).`);
    niceForWorktree(child.pid, env);
    const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;
    const exited = running(child) ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve();
    const pid = child.pid;
    const proc: RunProcess = { pid, alive: () => running(child), kill: () => endProcess(child).then(() => void (look && hooks.afterLook?.(pid))), exited };
    const rpc = new CodexRpc(child.stdout, child.stdin, { name: spec.label, jsonrpc: true });
    try {
      const init = await acpHandshake(rpc);
      return { rpc, proc, init, stderr: () => lines };
    } catch (err) {
      await proc.kill();
      throw new Error(`${spec.label} didn’t start: ${err instanceof Error ? err.message : String(err)}${lines.length ? ` (${lines.at(-1)})` : ''}`);
    }
  };
}
