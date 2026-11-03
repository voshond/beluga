import { writeSync } from 'node:fs';
import { parseConfig } from '../config.js';
import { belugaEnv } from '../core/beluga-env.js';
import { installedVersion } from '../core/version.js';
import { openDaemonLog } from '../daemon/files.js';
import { type DaemonOptions, runDaemon } from '../daemon/main.js';
import { APP_ORIGINS } from '../daemon/server.js';
import { type WebArgs, splitWebArgs } from '../daemon/web.js';
import { useClaudeToken } from './claude.js';

/** The daemon's options from the environment: the Mac app's origins, and the test and perf knobs. */
export function daemonOptions(keepAlive: boolean): DaemonOptions {
  // The Mac app's web view; BELUGA_ALLOW_ORIGINS adds more (its dev server while developing).
  const extra = (belugaEnv('ALLOW_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  // BELUGA_LAG_EVERY_MS: log the event-loop delay more often than every 30 s (scripts/perf-lag.mjs).
  const lagEveryMs = Number(belugaEnv('LAG_EVERY_MS')) || undefined;
  return {
    version: installedVersion(),
    keepAlive: keepAlive || belugaEnv('KEEP_ALIVE') === '1',
    allowedOrigins: [...APP_ORIGINS, ...extra],
    ...(lagEveryMs ? { lagEveryMs } : {}),
    ...(belugaEnv('STOP_ON_INPUT_END') === '1' ? { stopWithInput: process.stdin } : {}),
  };
}

/** `beluga daemon [--keep-alive] [demo]`: what the Mac app starts (src-tauri/src/daemon.rs), and `beluga up` in the background. */
export async function daemon(args: readonly string[]): Promise<void> {
  const { rest, keepAlive, web } = daemonArgs(args);
  useClaudeToken();
  await runDaemon(parseConfig(rest), { ...daemonOptions(keepAlive), ...(web ? { web } : {}) });
}

/** `daemon`'s line: --keep-alive, the web port's options (`--listen`, `--allow-host`, `--insecure-http`: they open it, as `beluga web` does), and the room's own. */
export function daemonArgs(args: readonly string[]): { rest: string[]; keepAlive: boolean; web?: WebArgs } {
  const asked = args.some((a) => /^--(listen|allow-host|insecure-http)(=|$)/.test(a));
  const { web, rest } = splitWebArgs(args.filter((a) => a !== '--keep-alive'));
  return { rest, keepAlive: args.includes('--keep-alive'), ...(asked ? { web } : {}) };
}

/**
 * `beluga up --foreground`: the daemon in this process, kept alive, for systemd, launchd or Docker.
 * Its lines go to this terminal and to daemon.log, so `beluga logs` reads them either way.
 */
export async function foreground(): Promise<void> {
  useClaudeToken();
  const fd = openDaemonLog();
  const log = (line: string): void => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(text);
    try {
      writeSync(fd, text);
    } catch {
      // A full disk mustn't stop Beluga; the terminal still has the line.
    }
  };
  await runDaemon(parseConfig([]), { ...daemonOptions(true), log });
}
