import { COMPANION_PROTO, type MacFrame, type PhoneFrame, SINCE, type Topic, viewSchema } from './protocol';

/**
 * What the phone shows of each computer of yours (BLG-810): the topics on screen for it, its views
 * (kept, so an offline computer's work still opens, read-only), and calls made on its own link.
 * Views are keyed by computer and topic: `work` on the Mac and `work` on the Mac mini are two.
 *
 * Kept free of React Native: lib/store.ts owns one beside ComputerLinks, and
 * tests/companion-computer-work.test.ts drives it with a fake sender.
 */

export interface ComputerView<T = unknown> {
  readonly data: T;
  readonly rev: number;
  readonly at: number;
  /** From the phone's cache, not (yet) from that computer this session. */
  readonly stale: boolean;
}

export interface ComputerWorkOptions {
  /** Send one frame on a computer's link; false when it isn't open. */
  readonly send: (id: string, frame: PhoneFrame) => boolean;
  /** Its protocol from its welcome (none yet: only what every 1.x has). */
  readonly proto: (id: string) => { readonly major: number; readonly minor: number } | undefined;
  /** Its name, for "the Mac mini is away". */
  readonly name: (id: string) => string | undefined;
  /** A view or the set of topics changed: `view:<id>|<topic>`. */
  readonly emit: (key: string) => void;
  readonly load?: () => Record<string, { data: unknown; rev: number; at: number }> | undefined;
  readonly save?: (kept: Record<string, { data: unknown; rev: number; at: number }>) => void;
  readonly now?: () => number;
  /** Topics a computer is asked for besides its own screens' (your Always On: the friends screens', BLG-850). */
  readonly extra?: (id: string) => readonly Topic[];
  /** How long a call waits for its answer. */
  readonly timeoutMs?: number;
}

/** Views kept across launches: the list topics and the last conversations, over every computer. */
const KEPT_VIEWS = 32;
const CALL_TIMEOUT_MS = 30_000;
const MAX_TOPICS = 16;

export const viewKey = (id: string, topic: Topic): string => `${id}|${topic}`;

export class ComputerWork {
  private readonly views = new Map<string, ComputerView>();
  private readonly subs = new Map<string, Map<Topic, number>>();
  private readonly pending = new Map<number, { readonly id: string; readonly resolve: (v: unknown) => void; readonly reject: (e: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();
  private seq = 1;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: ComputerWorkOptions) {
    for (const [key, v] of Object.entries(opts.load?.() ?? {})) this.views.set(key, { ...v, stale: true });
  }

  /** Does that computer have this (its protocol's minor)? */
  supports(id: string, what: keyof typeof SINCE): boolean {
    const v = this.opts.proto(id);
    if (!v) return false;
    return v.major > COMPANION_PROTO.major || (v.major === COMPANION_PROTO.major && v.minor >= SINCE[what]);
  }

  /** A screen shows `topic` of computer `id`: it's subscribed on that link while mounted. */
  watch(id: string, topic: Topic): () => void {
    const counts = this.subs.get(id) ?? new Map<Topic, number>();
    this.subs.set(id, counts);
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
    this.resub(id);
    return () => {
      const n = (counts.get(topic) ?? 1) - 1;
      if (n <= 0) counts.delete(topic);
      else counts.set(topic, n);
      this.resub(id);
    };
  }

  /** The topics on screen for a computer (its hello says them, and each `sub`). */
  topics(id: string): Topic[] {
    return [...new Set([...(this.subs.get(id)?.keys() ?? []), ...(this.opts.extra?.(id) ?? [])])].slice(0, MAX_TOPICS);
  }

  view<T>(id: string, topic: Topic): ComputerView<T> | undefined {
    return this.views.get(viewKey(id, topic)) as ComputerView<T> | undefined;
  }

  /** Its link opened, or what's asked of it changed: say what's on screen (the hello said what was then). */
  opened(id: string): void {
    this.resub(id);
  }

  /** Its link closed: calls in flight won't be answered. */
  closed(id: string): void {
    for (const [n, p] of [...this.pending]) {
      if (p.id !== id) continue;
      this.pending.delete(n);
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(`${this.opts.name(id) ?? 'That computer'} went away.`), { lost: true }));
    }
  }

  /** A computer gone from your devices: its views go too. */
  forget(id: string): void {
    this.closed(id);
    this.subs.delete(id);
    for (const key of [...this.views.keys()]) if (key.startsWith(`${id}|`)) this.views.delete(key);
    this.persist();
  }

  /** A frame from a computer: its views and its answers are taken here (true), the rest isn't. */
  take(id: string, f: MacFrame): boolean {
    if (f.t === 'view') {
      const parsed = viewSchema(f.topic).safeParse(f.data);
      if (!parsed.success) return true;
      this.views.set(viewKey(id, f.topic), { data: parsed.data, rev: f.rev, at: this.opts.now?.() ?? Date.now(), stale: false });
      this.opts.emit(`view:${viewKey(id, f.topic)}`);
      this.persist();
      return true;
    }
    if (f.t === 'result') {
      const p = this.pending.get(f.id);
      if (!p || p.id !== id) return false;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.value);
      else p.reject(new Error(f.error ?? `${this.opts.name(id) ?? 'That computer'} said no.`));
      return true;
    }
    return false;
  }

  /** An API call on that computer's own link (the phone table applies there). Never queued: it says when it's away. */
  call<T = unknown>(id: string, method: string, args: readonly unknown[]): Promise<T> {
    const n = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(n)) return;
        reject(new Error(`${this.opts.name(id) ?? 'That computer'} didn’t answer.`));
      }, this.opts.timeoutMs ?? CALL_TIMEOUT_MS);
      this.pending.set(n, { id, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.opts.send(id, { t: 'call', id: n, method, args: [...args] })) {
        this.pending.delete(n);
        clearTimeout(timer);
        reject(new Error(`${this.opts.name(id) ?? 'That computer'} is away.`));
      }
    });
  }

  private resub(id: string): void {
    this.opts.send(id, { t: 'sub', topics: this.topics(id) });
  }

  private persist(): void {
    if (!this.opts.save || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const newest = [...this.views].sort((a, b) => b[1].at - a[1].at).slice(0, KEPT_VIEWS);
      this.opts.save?.(Object.fromEntries(newest.map(([k, v]) => [k, { data: v.data, rev: v.rev, at: v.at }])));
    }, 1000);
  }
}
