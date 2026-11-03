import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { daemonLogPath } from '../daemon/files.js';
import { type Exit, type Io } from './io.js';
import { tilde } from './paths.js';

export const DEFAULT_LINES = 50;
const POLL_MS = 300;

export interface LogsOptions {
  readonly follow: boolean;
  readonly lines: number;
  readonly file?: string;
  /** Ends --follow (Ctrl+C). */
  readonly signal?: AbortSignal;
}

const sizeOf = (file: string): number | undefined => {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
};

/** The last `n` lines of a log. */
export function lastLines(text: string, n: number): string {
  if (n === 0) return '';
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length ? `${lines.slice(-n).join('\n')}\n` : '';
}

function readFrom(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, from));
  } finally {
    closeSync(fd);
  }
}

/** Wait a moment, or less once the signal fires. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** `beluga logs [-f] [-n N]`: the daemon's log, the same file the Mac app's daemon writes. */
export async function logs(opts: LogsOptions, io: Io): Promise<Exit> {
  const file = opts.file ?? daemonLogPath();
  let pos = sizeOf(file);
  if (pos === undefined && !opts.follow) {
    io.err(`There's no log yet (${tilde(file)}). Beluga writes one once it starts: \`beluga up\`.\n`);
    return 1;
  }
  if (pos !== undefined) io.out(lastLines(readFileSync(file, 'utf8'), opts.lines));
  else io.err('No log yet; waiting for Beluga to start (Ctrl+C to stop).\n');
  if (!opts.follow) return 0;
  pos ??= 0;
  while (!opts.signal?.aborted) {
    await pause(POLL_MS, opts.signal);
    const size = sizeOf(file) ?? 0;
    // Started fresh (it grew past 5 MB and was set aside as daemon.log.1): read the new one from its start.
    if (size < pos) pos = 0;
    if (size <= pos) continue;
    // Whole lines only, so a line (or a character) being written isn't cut in two.
    const chunk = readFrom(file, pos, size);
    const end = chunk.lastIndexOf(0x0a) + 1;
    if (!end) continue;
    io.out(chunk.subarray(0, end).toString('utf8'));
    pos += end;
  }
  return 0;
}
