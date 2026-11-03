import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Beluga as `beluga web` runs it, for the web project's specs: the demo daemon with its web port
 * on a free port, serving packages/mac's build (dist/), in a home of its own. Its first join link
 * comes from what the command prints.
 */

const repo = path.resolve(import.meta.dirname, '../../../..');
const dist = path.resolve(import.meta.dirname, '../../dist');
const run = promisify(execFile);

export interface Served {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  /** The first join link it printed. */
  readonly link: string;
  readonly home: string;
  /** `beluga web …` against this Beluga (another link, sessions, revoke). */
  cli(...args: string[]): Promise<string>;
  /** The browsers let in, as web-sessions.json keeps them. */
  sessions(): Array<{ id: string; name: string }>;
  stop(): Promise<void>;
}

export async function startServed(): Promise<Served> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-web-'));
  writeFileSync(path.join(home, '.klaud-e2e'), 'A demo home for the web e2e.\n');
  const env = { ...process.env, BELUGA_HOME: home, KLAUD_HOME: home, BELUGA_CLAUDE_HOME: path.join(home, 'claude'), KLAUD_CLAUDE_HOME: path.join(home, 'claude'), BELUGA_WEB_ROOT: dist, BELUGA_NETWORK: '', KLAUD_NETWORK: '', BELUGA_DEMO_PACE: '0.3', KLAUD_DEMO_PACE: '0.3' };
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'web', '--listen', '127.0.0.1:0', 'demo'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = (): void => void child.kill('SIGTERM');
  process.once('exit', kill);
  let out = '';
  let err = '';
  child.stderr?.on('data', (c: Buffer) => void (err = (err + c.toString()).slice(-4000)));
  const link = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`beluga web didn't print a link in 90 s:\n${out}\n${err}`)), 90_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      const found = /(http:\/\/\S+\/join#\S+)/.exec(out)?.[1];
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`beluga web exited (${code}):\n${out}\n${err}`));
    });
  });
  const url = new URL(link).origin;
  return {
    url,
    link,
    home,
    cli: async (...args) => (await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'web', ...args], { cwd: repo, env })).stdout,
    sessions: () => (JSON.parse(readFileSync(path.join(home, 'web-sessions.json'), 'utf8')) as { sessions: Array<{ id: string; name: string }> }).sessions,
    stop: async () => {
      process.off('exit', kill);
      if (child.exitCode !== null) return;
      const gone = new Promise((r) => child.once('exit', r));
      kill();
      await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
