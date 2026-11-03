import { spawn } from 'node:child_process';
import { closeSync, realpathSync } from 'node:fs';
import { daemonLogPath, openDaemonLog, releaseLock, runningDaemon, takeLock } from '../daemon/files.js';
import type { DaemonInfo } from '../ipc/protocol.js';
import { type Exit, type Io, ago } from './io.js';
import { tilde } from './paths.js';

/** How long `beluga up` waits for a background daemon to say it's listening. */
export const UP_WAIT_MS = 60_000;

export interface UpDeps {
  /** Start the daemon in the background; resolves with why if it stops before it's listening. */
  readonly start: () => Promise<string>;
  /** Run the daemon in this process until it stops. */
  readonly foreground: () => Promise<void>;
  readonly waitMs?: number;
}

/** This very command again, as `daemon --keep-alive`, detached, its output to daemon.log. */
export function startInBackground(): Promise<string> {
  const fd = openDaemonLog();
  const entry = realpathSync(process.argv[1]!);
  const child = spawn(process.execPath, [...process.execArgv, entry, 'daemon', '--keep-alive'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  closeSync(fd);
  const died = new Promise<string>((resolve) => {
    child.once('error', (err) => resolve(err.message));
    child.once('exit', (code, signal) => resolve(signal ? `stopped by ${signal}` : `exited with code ${code}`));
  });
  child.unref();
  return died;
}

const listening = (info: DaemonInfo): string => `on 127.0.0.1:${info.port} (this computer only)`;

/** Wait for daemon.json to name a live daemon, or for the start to fail. */
async function waitForDaemon(died: Promise<string>, waitMs: number): Promise<DaemonInfo | string> {
  let why: string | undefined;
  void died.then((reason) => (why = reason));
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const info = runningDaemon();
    if (info) return info;
    if (why) return `it stopped while starting (${why})`;
    await new Promise((r) => setTimeout(r, 100));
  }
  return `it didn't start within ${Math.round(waitMs / 1000)} seconds`;
}

/** `beluga up`: start Beluga kept alive in the background, or here with --foreground. */
export async function up(flags: { foreground?: boolean }, io: Io, deps: UpDeps): Promise<Exit> {
  const running = runningDaemon();
  if (running) {
    const since = ago(Date.now() - running.startedAt);
    if (flags.foreground) {
      io.err(`Beluga is already running in the background (pid ${running.pid}). Stop it with \`beluga stop\`, then run \`beluga up --foreground\` again.\n`);
      return 1;
    }
    io.out(`Beluga is already running ${listening(running)}, started ${since} ago.\n`);
    return 0;
  }
  if (flags.foreground) {
    io.err('Starting Beluga in this terminal. Ctrl+C stops it.\n');
    await deps.foreground();
    return 0;
  }
  if (!takeLock()) {
    io.err('Beluga is starting already (the Mac app, or another `beluga up`); waiting for it…\n');
    const info = await waitForDaemon(new Promise(() => undefined), deps.waitMs ?? UP_WAIT_MS);
    return said(info, io);
  }
  try {
    io.err('Starting Beluga…\n');
    return said(await waitForDaemon(deps.start(), deps.waitMs ?? UP_WAIT_MS), io);
  } finally {
    releaseLock();
  }
}

function said(info: DaemonInfo | string, io: Io): Exit {
  if (typeof info === 'string') {
    io.err(`Beluga didn't start: ${info}. Its log says why: \`beluga logs\` (${tilde(daemonLogPath())}).\n`);
    return 1;
  }
  io.out(`Beluga is running ${listening(info)}, and stays up after you close this terminal.\nSee it with \`beluga status\`, its log with \`beluga logs -f\`, and stop it with \`beluga stop\`.\n`);
  return 0;
}
