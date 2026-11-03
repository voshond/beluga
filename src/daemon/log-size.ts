import { copyFileSync, fstatSync, ftruncateSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { LOG_LIMIT, daemonLogPath } from './files.js';

/**
 * Keeps daemon.log small while the daemon runs, which can be weeks: the app (or `beluga up`)
 * opens it once and the daemon writes to it, so setting it aside only at a start isn't enough.
 * Past LOG_LIMIT its lines are copied to daemon.log.1 and the file starts over in place. The
 * writer opened it to append, so its next line lands at the new start (BLG-668).
 */

/** How often the log's size is looked at. */
export const LOG_CHECK_EVERY_MS = 10 * 60_000;

/** `trimmed`: started over; `kept`: small, or not daemon.log at all (a terminal, a pipe); `cannot`: it can't be from here. */
export type TrimResult = 'trimmed' | 'kept' | 'cannot';

/** If `fd` writes `file` and it's grown past `limit`, set its lines aside as `file`.1 and start it over. */
export function trimLog(fd: number, file = daemonLogPath(), limit = LOG_LIMIT): TrimResult {
  let open;
  let named;
  try {
    open = fstatSync(fd);
    named = statSync(file);
  } catch {
    return 'kept';
  }
  // Only the file itself: a terminal, a pipe, or a log somewhere else is left alone.
  if (!open.isFile() || open.dev !== named.dev || open.ino !== named.ino || open.size <= limit) return 'kept';
  try {
    copyFileSync(file, `${file}.1`);
  } catch {
    return 'cannot';
  }
  try {
    ftruncateSync(fd, 0);
    return 'trimmed';
  } catch {
    // Windows: an append-only handle can't truncate, but the file can be, by name (its writers share it).
  }
  try {
    truncateSync(file, 0);
    return 'trimmed';
  } catch {
    // It's set aside at the next start instead (the app's log_file()).
    return 'cannot';
  }
}

export interface KeepLogSmallOptions {
  readonly file?: string;
  readonly limit?: number;
  readonly everyMs?: number;
}

/** Trim the log `fd` writes now and every so often; returns a stop. */
export function keepLogSmall(fd: number, log: (line: string) => void, opts: KeepLogSmallOptions = {}): () => void {
  const file = opts.file ?? daemonLogPath();
  const check = (): void => {
    const result = trimLog(fd, file, opts.limit);
    if (result === 'trimmed') log(`log started over: the older lines are in ${path.basename(file)}.1`);
    if (result === 'cannot') stop();
  };
  const timer = setInterval(check, opts.everyMs ?? LOG_CHECK_EVERY_MS);
  timer.unref?.();
  const stop = (): void => clearInterval(timer);
  check();
  return stop;
}
