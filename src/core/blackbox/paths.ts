import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Entry, Snapshot } from './recorder.js';

/** Where the black box is kept on disk: all in ~/.beluga/logs, next to daemon.log. */
export interface BlackboxPaths {
  readonly logs: string;
  /** The running daemon's black box, a journal: a line about the run, then one line per entry. */
  readonly current: string;
  /** The one before it: after a crash, what led up to it. */
  readonly previous: string;
  /** Frozen copies from problems, the Mac app's notes of a daemon that died, and Node's crash reports. */
  readonly incidents: string;
  /** Reports made to send (Settings › About › Report a Problem). */
  readonly reports: string;
}

export function blackboxPaths(logs = path.join(belugaHome(), 'logs')): BlackboxPaths {
  return {
    logs,
    current: path.join(logs, 'blackbox.jsonl'),
    previous: path.join(logs, 'blackbox.previous.jsonl'),
    incidents: path.join(logs, 'incidents'),
    reports: path.join(logs, 'reports'),
  };
}

/** Keep the newest `keep` files in a folder, by when they were written. */
export function pruneFolder(dir: string, keep: number): void {
  let files: { file: string; at: number }[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ file: path.join(dir, name), at: statSync(path.join(dir, name)).mtimeMs }));
  } catch {
    return;
  }
  files.sort((a, b) => b.at - a.at);
  for (const { file } of files.slice(keep)) rmSync(file, { force: true });
}

/** A journal read back (daemon/blackbox.ts writes it); a line cut short by a crash is skipped. */
export function readJournal(file: string): Snapshot | undefined {
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
  const parsed = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  const [head, ...rest] = parsed as [{ version?: string; pid?: number; startedAt?: number } | undefined, ...Entry[]];
  if (!head) return undefined;
  // A journal rewritten when it grew starts again with its head line: keep the entries only.
  const entries = rest.filter((e) => typeof e === 'object' && e !== null && 'kind' in e);
  return { version: String(head.version ?? ''), pid: Number(head.pid ?? 0), startedAt: Number(head.startedAt ?? 0), savedAt: entries.at(-1)?.t ?? 0, entries };
}
