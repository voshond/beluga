import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BlackboxPaths, blackboxPaths, pruneFolder } from '../core/blackbox/paths.js';
import { type Entry, type Recorder, type Snapshot, blackbox } from '../core/blackbox/recorder.js';

/**
 * Where the black box (core/blackbox/recorder.ts) is kept on disk, so it outlives the daemon: a
 * journal that gets what's new appended in the background once a minute and right away when the
 * daemon exits, so even a daemon that's killed leaves all but its last minute behind. Each problem (an uncaught error, a promise
 * nobody caught) freezes a copy into logs/incidents/, and a fatal crash Node can't survive (out of
 * memory, a native fault) writes Node's own diagnostic report there (BLG-673).
 */

export const SAVE_EVERY_MS = 60_000;
/** Past this the journal is rewritten with only what the ring holds. */
export const JOURNAL_MAX = 2 * 1024 * 1024;
/** How many incidents (and Node crash reports) are kept. */
export const KEEP_INCIDENTS = 10;
/** A burst of the same problem freezes one copy, not one per throw. */
export const INCIDENT_GAP_MS = 60_000;

export interface Blackbox {
  /** Something went wrong: note it, and freeze a copy unless one was just frozen. */
  incident(reason: string, detail: string): void;
  /** Save now, synchronously (the daemon is exiting). */
  saveNow(reason: string): void;
  stop(): void;
}

export interface BlackboxOptions {
  readonly version: string;
  readonly recorder?: Recorder;
  readonly paths?: BlackboxPaths;
  readonly everyMs?: number;
  /** Override JOURNAL_MAX (tests). */
  readonly journalMax?: number;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'incident';
const stamp = (t: number): string => new Date(t).toISOString().replace(/[:.]/g, '-');

/** Ask Node to write its diagnostic report into the incidents folder if it dies of something fatal. */
function reportFatalErrors(dir: string): void {
  try {
    const report = process.report;
    report.directory = dir;
    report.reportOnFatalError = true;
    // Newer than these types: no network handles, and (Node 23.3+) no environment, with the secrets it may hold.
    const newer = report as { excludeNetwork?: boolean; excludeEnv?: boolean };
    newer.excludeNetwork = true;
    if ('excludeEnv' in report) newer.excludeEnv = true;
  } catch {
    // An older Node without reports: the black box still has the minute before.
  }
}

/** Start keeping the black box on disk; the last daemon's is set aside as blackbox.previous.jsonl. */
export function startBlackbox(opts: BlackboxOptions): Blackbox {
  const recorder = opts.recorder ?? blackbox;
  const paths = opts.paths ?? blackboxPaths();
  const startedAt = Date.now();
  mkdirSync(paths.incidents, { recursive: true, mode: 0o700 });
  try {
    renameSync(paths.current, paths.previous);
  } catch {
    // The first start, or it was already set aside.
  }
  pruneFolder(paths.incidents, KEEP_INCIDENTS);
  reportFatalErrors(paths.incidents);
  recorder.record('start', `Beluga ${opts.version} started (pid ${process.pid}, Node ${process.version}, ${process.platform} ${process.arch})`);

  const head = `${JSON.stringify({ version: opts.version, pid: process.pid, startedAt })}\n`;
  const lines = (entries: readonly Entry[]): string => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
  const snapshot = (reason?: string): string =>
    JSON.stringify({ version: opts.version, pid: process.pid, startedAt, savedAt: Date.now(), ...(reason ? { reason } : {}), entries: recorder.entries() } satisfies Snapshot);
  const tmp = `${paths.current}.${process.pid}.tmp`;
  const journalMax = opts.journalMax ?? JOURNAL_MAX;

  // Only what's new is appended (a few hundred bytes a minute); past journalMax it's rewritten with what the ring holds.
  let saved = recorder.version;
  let size = 0;
  try {
    const first = head + lines(recorder.entries());
    writeFileSync(paths.current, first, { mode: 0o600 });
    size = first.length;
  } catch {
    // Nowhere to write: the black box still works in memory.
  }
  let saving = false;
  const save = async (): Promise<void> => {
    if (saving || recorder.version === saved) return;
    saving = true;
    const version = recorder.version;
    try {
      if (size > journalMax) {
        const whole = head + lines(recorder.entries());
        await writeFile(tmp, whole, { mode: 0o600 });
        await rename(tmp, paths.current);
        size = whole.length;
      } else {
        const fresh = lines(recorder.since(saved));
        await appendFile(paths.current, fresh, { mode: 0o600 });
        size += fresh.length;
      }
      saved = version;
    } catch {
      // A full disk mustn't stop Beluga; the next minute tries again.
    } finally {
      saving = false;
    }
  };
  const timer = setInterval(() => void save(), opts.everyMs ?? SAVE_EVERY_MS);
  timer.unref?.();

  let lastIncident = 0;
  return {
    incident(reason, detail) {
      recorder.record('incident', `${reason}: ${detail}`);
      const now = Date.now();
      if (now - lastIncident < INCIDENT_GAP_MS) return;
      lastIncident = now;
      try {
        writeFileSync(path.join(paths.incidents, `${stamp(now)}-${slug(reason)}.json`), snapshot(reason), { mode: 0o600 });
        pruneFolder(paths.incidents, KEEP_INCIDENTS);
      } catch {
        // Kept in memory anyway, and in the next save.
      }
    },
    saveNow(reason) {
      recorder.record('stop', reason);
      try {
        appendFileSync(paths.current, lines(recorder.since(saved)), { mode: 0o600 });
        saved = recorder.version;
      } catch {
        // Exiting: nothing more to do.
      }
    },
    stop() {
      clearInterval(timer);
    },
  };
}
