/**
 * The daemon's black box: what it did lately, kept in memory so that when something goes wrong
 * the minutes before it can be read back (a crash, a freeze, "it just stopped"), without asking
 * the person what they saw (BLG-673).
 *
 * Built to cost nothing you'd notice: a fixed ring of entries, no I/O (daemon/blackbox.ts saves
 * it now and then), and the busy things (every API call, every state change) only counted per
 * period, so a Claude streaming can't push the useful history out, and recording one is a map
 * increment. One entry per call only when it failed or was slow.
 */

export type EntryKind = 'start' | 'stop' | 'log' | 'error' | 'call' | 'period' | 'incident';

export interface Entry {
  /** When, in ms since the epoch. */
  readonly t: number;
  readonly kind: EntryKind;
  readonly text: string;
  readonly data?: Readonly<Record<string, number>>;
}

/** A black box as saved. */
export interface Snapshot {
  readonly version: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly savedAt: number;
  /** Why this copy was made (an incident, the daemon exiting); none for the minute's save. */
  readonly reason?: string;
  readonly entries: readonly Entry[];
}

/** How many entries are kept: about a day of quiet periods, or the last stretch of a busy one. */
export const RING_SIZE = 3000;
/** Longer text (a big stack) is cut to this. */
export const TEXT_MAX = 4000;
/** A call this slow gets an entry of its own. */
export const SLOW_CALL_MS = 1000;
/** How many of the busiest calls and actions a period names. */
const TOP = 5;

interface CallCount {
  n: number;
  failed: number;
  ms: number;
}

export interface PeriodStats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

const cut = (text: string): string => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text);

const top = (counts: ReadonlyMap<string, number>): string =>
  [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([name, n]) => `${name} ×${n}`)
    .join(', ');

export class Recorder {
  // A ring, written in place: allocating per entry is the one cost worth avoiding here.
  private readonly ring: (Entry | undefined)[];
  private next = 0;
  private count = 0;
  private readonly calls = new Map<string, CallCount>();
  private readonly actions = new Map<string, number>();
  private changed = 0;

  constructor(private readonly size = RING_SIZE) {
    this.ring = new Array<Entry | undefined>(size);
  }

  /** Something that happened, in words. */
  record(kind: EntryKind, text: string, data?: Readonly<Record<string, number>>): void {
    this.ring[this.next] = { t: Date.now(), kind, text: cut(text), ...(data ? { data } : {}) };
    this.next = (this.next + 1) % this.size;
    this.count = Math.min(this.count + 1, this.size);
    this.changed++;
  }

  /** An API call finished (counted; an entry only when it failed or was slow). */
  call(method: string, ms: number, error?: string): void {
    const c = this.calls.get(method) ?? { n: 0, failed: 0, ms: 0 };
    c.n++;
    c.ms += ms;
    if (error !== undefined) c.failed++;
    this.calls.set(method, c);
    if (error !== undefined) this.record('call', `${method} failed after ${Math.round(ms)} ms: ${error}`);
    else if (ms >= SLOW_CALL_MS) this.record('call', `${method} took ${Math.round(ms)} ms`);
  }

  /** A state change (counted only). */
  action(type: string): void {
    this.actions.set(type, (this.actions.get(type) ?? 0) + 1);
  }

  /** A period ended: its event-loop delay, memory, and what it was busy with. Starts the counts over. */
  period(lag: PeriodStats, memory: { readonly rss: number; readonly heapUsed: number }): void {
    let calls = 0;
    let failed = 0;
    const byCall = new Map<string, number>();
    for (const [method, c] of this.calls) {
      calls += c.n;
      failed += c.failed;
      byCall.set(method, c.n);
    }
    let actions = 0;
    for (const n of this.actions.values()) actions += n;
    const busy = [calls ? `calls: ${top(byCall)}` : '', actions ? `actions: ${top(this.actions)}` : ''].filter(Boolean).join('; ');
    const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
    this.record('period', busy || 'idle', {
      p50: round(lag.p50),
      p95: round(lag.p95),
      max: round(lag.max),
      rssMb: mb(memory.rss),
      heapMb: mb(memory.heapUsed),
      calls,
      failed,
      actions,
    });
    this.calls.clear();
    this.actions.clear();
  }

  /** What's kept, oldest first. */
  entries(): Entry[] {
    const start = this.count < this.size ? 0 : this.next;
    const out: Entry[] = [];
    for (let i = 0; i < this.count; i++) {
      const e = this.ring[(start + i) % this.size];
      if (e) out.push(e);
    }
    return out;
  }

  /** The entries recorded after `version` was read (those still kept), oldest first. */
  since(version: number): Entry[] {
    const n = Math.min(this.changed - version, this.count);
    const out: Entry[] = [];
    for (let i = n; i > 0; i--) {
      const e = this.ring[(this.next - i + this.size) % this.size];
      if (e) out.push(e);
    }
    return out;
  }

  /** How many entries were ever recorded: read it, and `since` it later for what's new. */
  get version(): number {
    return this.changed;
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** This process's black box. */
export const blackbox = new Recorder();
