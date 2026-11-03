import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../../shared/steps.js';
import { type BlackboxPaths, blackboxPaths, pruneFolder, readJournal } from './paths.js';
import { type Recorder, blackbox } from './recorder.js';

/**
 * A problem report: everything the black box knows, in one file someone can send without having
 * to describe what they saw (BLG-673). It has what the daemon did lately (and the run before, after
 * a crash), the problems it froze, how a daemon died, Node's crash reports, and the end of
 * daemon.log. Secrets are redacted, the home folder reads ~, and environment variables and API
 * arguments are never in it. Nothing is sent: the person attaches the file themselves.
 */

/** How much of the end of daemon.log goes in. */
export const LOG_TAIL_BYTES = 256 * 1024;
/** How many reports are kept in logs/reports. */
const KEEP_REPORTS = 5;
/** How deep a Node crash report's native stack is kept. */
const NATIVE_FRAMES = 40;

export interface ReportSummary {
  readonly version: string;
  readonly os: string;
  /** How many problems were frozen (incidents, crashes, a daemon that died). */
  readonly problems: number;
  /** The newest of them, in a few words. */
  readonly lastProblem?: string;
}

export interface Report {
  readonly path: string;
  readonly summary: ReportSummary;
}

export interface ReportOptions {
  readonly version: string;
  readonly recorder?: Recorder;
  readonly paths?: BlackboxPaths;
  readonly home?: string;
  readonly now?: number;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

/** The last `bytes` of a file, from its first whole line. */
function tail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Node diagnostic report, cut to what says why it died: no environment, command line, libraries or handles. */
function nodeReport(report: Json): Json {
  const header = isObject(report.header) ? report.header : {};
  const keep = ['event', 'trigger', 'dumpEventTime', 'nodejsVersion', 'osName', 'osRelease', 'osMachine', 'arch', 'platform', 'processId'];
  const native = Array.isArray(report.nativeStack) ? report.nativeStack.slice(0, NATIVE_FRAMES) : undefined;
  return {
    kind: 'node crash report',
    header: Object.fromEntries(keep.filter((k) => k in header).map((k) => [k, header[k]])),
    javascriptStack: report.javascriptStack,
    ...(native ? { nativeStack: native } : {}),
    javascriptHeap: report.javascriptHeap,
    resourceUsage: report.resourceUsage,
  };
}

/** The problem an incident file is about, in a few words. */
function problemOf(name: string, body: unknown): string {
  if (!isObject(body)) return name;
  if (body.kind === 'node crash report' && isObject(body.header)) return `Node crashed: ${String(body.header.event ?? body.header.trigger ?? 'fatal error')}`;
  if (body.kind === 'exit') return `Beluga stopped by itself (${String(body.status ?? 'unknown')})`;
  if (typeof body.reason === 'string') return body.reason;
  return name;
}

/** Each incident, newest first: frozen black boxes, the Mac app's notes of a daemon that died, Node's reports. */
function incidents(dir: string): { file: string; problem: string; body: unknown }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map(({ name }) => {
      const raw = readJson(path.join(dir, name));
      const body = isObject(raw) && isObject(raw.header) && 'javascriptStack' in raw ? nodeReport(raw) : raw;
      return { file: name, problem: problemOf(name, body), body };
    });
}

/** Every string with secrets redacted and the home folder as ~. */
function scrub<T>(value: T, home: string): T {
  const homes = [home, home.replace(/\\/g, '/')].filter((h, i, all) => h.length > 1 && all.indexOf(h) === i);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return homes.reduce((text, h) => text.split(h).join('~'), redactSecrets(v));
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const stamp = (t: number): string => new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** Write a report into logs/reports and say where, with a summary for the issue it goes with. */
export function makeReport(opts: ReportOptions): Report {
  const paths = opts.paths ?? blackboxPaths();
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? Date.now();
  const recorder = opts.recorder ?? blackbox;
  const memory = process.memoryUsage();
  const osName = `${os.type()} ${os.release()} (${process.arch})`;
  const found = incidents(paths.incidents);
  const log = path.join(paths.logs, 'daemon.log');
  const recent = tail(log, LOG_TAIL_BYTES);
  // Just started over (log-size.ts): the end of the one before has the lead-up.
  const before = recent.length < LOG_TAIL_BYTES / 2 ? tail(`${log}.1`, LOG_TAIL_BYTES - recent.length) : '';
  const summary: ReportSummary = { version: opts.version, os: osName, problems: found.length, ...(found[0] ? { lastProblem: found[0].problem } : {}) };
  const report = scrub(
    {
      about: 'A Beluga problem report: what the daemon did lately, with secrets left out. Made to attach to an issue.',
      madeAt: new Date(now).toISOString(),
      summary,
      system: {
        node: process.version,
        cpus: os.cpus().length,
        memoryGb: Math.round(os.totalmem() / 1024 ** 3),
        freeMemoryGb: Math.round(os.freemem() / 1024 ** 3),
        uptimeMinutes: Math.round(process.uptime() / 60),
        rssMb: Math.round(memory.rss / 1024 ** 2),
        heapMb: Math.round(memory.heapUsed / 1024 ** 2),
      },
      blackbox: recorder.entries(),
      previousRun: readJournal(paths.previous),
      incidents: found,
      log: before ? `${before}\n--- daemon.log.1 ends, daemon.log starts ---\n${recent}` : recent,
    },
    home,
  );
  mkdirSync(paths.reports, { recursive: true, mode: 0o700 });
  const file = path.join(paths.reports, `beluga-report-${stamp(now)}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  pruneFolder(paths.reports, KEEP_REPORTS);
  return { path: file, summary: scrub(summary, home) };
}
