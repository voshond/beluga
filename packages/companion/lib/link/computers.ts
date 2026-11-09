import type { MacFrame, PhoneComputer, PhoneFrame } from './protocol';
import { RETRY_LIMIT, retryDelay } from './resume';
import type { LinkHints, LinkPhase } from './rpc';
import type { Transport } from './transport';

/**
 * Your computers, each linked by itself (BLG-809): your Mac tells the phone where each one is (the
 * `computers` frame, protocol 1.46), and the phone dials each with the certificate it already has,
 * with no second pairing and no Mac in the middle. So with your Mac asleep, the phone still reaches
 * the Mac mini at home or the server in the cloud, and a computer added later shows up on its own.
 *
 * One Transport per computer (a BareTransport whose pairing is that computer's address), opened
 * while the app is in front and closed with the Mac's link when it goes away (the battery rule).
 * Kept free of React Native: lib/store.ts owns one, and tests/companion-computers.test.ts drives it
 * with fake transports.
 */

/** idle: not dialed yet; asleep: tried, it doesn't answer; closed: in the background or dropped; refused: it turned this phone away. */
export type ComputerPhase = 'idle' | 'dialing' | 'open' | 'asleep' | 'closed' | 'refused';

export interface ComputerLinkState {
  readonly computer: PhoneComputer;
  readonly phase: ComputerPhase;
  readonly detail?: string;
  /** When this phone (or your Mac, before it ever did) last reached it. */
  readonly lastSeen?: number;
  /** What it said in its welcome: its name and Beluga, and its protocol (SINCE gates per computer). */
  readonly mac?: { readonly name: string; readonly version: string };
  readonly proto?: { readonly major: number; readonly minor: number };
}

/** What the phone keeps between launches (kv: nothing secret). */
export interface KeptComputers {
  readonly list: readonly PhoneComputer[];
  /** When this phone last had each one open, by id. */
  readonly seen: Readonly<Record<string, number>>;
}

export interface ComputerLinksOptions {
  /** A link to one computer (the real one: a BareTransport dialing its address with this phone's keys). */
  readonly make: (computer: PhoneComputer) => Transport;
  /** The hello each link opens with (the same as the Mac's: this phone's app, platform and topics). */
  readonly hello: (computer: PhoneComputer) => Extract<PhoneFrame, { t: 'hello' }>;
  /** Kept between launches. */
  readonly load?: () => KeptComputers | undefined;
  readonly save?: (kept: KeptComputers) => void;
  /** A frame from one computer (views, results, nudges): the store routes it. */
  readonly onFrame?: (id: string, frame: MacFrame) => void;
  /** Something any link shows changed (its phase, the list). */
  readonly onChange?: () => void;
  /** A computer's link opened, or left open (its calls in flight won't be answered). */
  readonly onOpen?: (id: string) => void;
  readonly onDown?: (id: string) => void;
  /** A computer is gone from your devices (its kept work goes too). */
  readonly onGone?: (id: string) => void;
  /** The address the phone's own pairing dials: that one is never linked twice. */
  readonly primary?: () => string | undefined;
  readonly now?: () => number;
  readonly random?: () => number;
}

interface Entry {
  computer: PhoneComputer;
  transport: Transport;
  offs: Array<() => void>;
  state: ComputerLinkState;
  attempt: number;
  retry?: ReturnType<typeof setTimeout>;
}

const hintsOf = (c: PhoneComputer): LinkHints => ({ relays: [...c.relays], prefer: {} });
/** A kept link that keeps dropping while away is tried this often (lib/store.ts does the same for the Mac's). */
const AWAY_RETRY_MS = 120_000;

export class ComputerLinks {
  private readonly entries = new Map<string, Entry>();
  private seen: Record<string, number>;
  private active = false;
  /** Kept open while the app is away (Stay connected): your Always On, so its nudges notify (BLG-850). */
  private kept: string | undefined;
  private disposed = false;

  constructor(private readonly opts: ComputerLinksOptions) {
    const kept = opts.load?.();
    this.seen = { ...(kept?.seen ?? {}) };
    if (kept?.list.length) this.setList(kept.list, false);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Each computer, with how its link is. */
  states(): ComputerLinkState[] {
    return [...this.entries.values()].map((e) => e.state);
  }

  get(id: string): ComputerLinkState | undefined {
    return this.entries.get(id)?.state;
  }

  /**
   * Your Mac said where your computers are now: a new one is linked at once (while you look), one
   * that went is closed and forgotten, one that moved is dialed at its new address.
   */
  setList(list: readonly PhoneComputer[], keep = true): void {
    if (this.disposed) return;
    const primary = this.opts.primary?.();
    const next = new Map(list.filter((c) => c.address !== primary).map((c) => [c.id, c]));
    for (const [id, e] of [...this.entries]) {
      const c = next.get(id);
      if (!c) {
        this.drop(id);
        this.opts.onGone?.(id);
      }
      else if (c.address !== e.computer.address || c.relays.join() !== e.computer.relays.join()) this.drop(id);
      else e.computer = c;
    }
    for (const [id, c] of next) {
      const e = this.entries.get(id);
      if (e) {
        this.update(e, { computer: c, ...this.seenOf(c) });
        continue;
      }
      this.add(c);
    }
    if (keep) this.keep();
    this.opts.onChange?.();
  }

  /** The app is in front: dial every computer that isn't open or dialing; one kept open while away is back in front. */
  open(): void {
    this.active = true;
    this.kept = undefined;
    for (const e of this.entries.values()) {
      e.attempt = 0;
      this.clearRetry(e);
      if (e.state.phase === 'open') {
        e.transport.send({ t: 'focus', on: true });
        this.opts.onOpen?.(e.computer.id);
      } else if (e.state.phase !== 'dialing' && e.state.phase !== 'refused') this.dial(e);
    }
  }

  /**
   * Away with Stay connected: only `keep` stays linked (dialed if it isn't), told the app is away
   * and showing nothing, so it sends nudges and no views; the others close. None: all close.
   */
  stayAway(keep: string | undefined): void {
    this.active = false;
    this.kept = keep;
    for (const e of this.entries.values()) {
      this.clearRetry(e);
      if (e.computer.id !== keep) {
        if (e.state.phase === 'open') e.transport.send({ t: 'bye' });
        if (e.state.phase === 'open' || e.state.phase === 'dialing') e.transport.close('background');
        continue;
      }
      e.attempt = 0;
      if (e.state.phase === 'open') {
        e.transport.send({ t: 'focus', on: false });
        e.transport.send({ t: 'sub', topics: [] });
      } else if (e.state.phase !== 'dialing' && e.state.phase !== 'refused') this.dial(e);
    }
  }

  /** The app went away past the grace (or you signed out): every link closes, nothing retries. */
  close(reason: string): void {
    this.active = false;
    this.kept = undefined;
    for (const e of this.entries.values()) {
      this.clearRetry(e);
      if (e.state.phase === 'open') e.transport.send({ t: 'bye' });
      if (e.state.phase === 'open' || e.state.phase === 'dialing') e.transport.close(reason);
    }
  }

  /** One frame to one computer (only once its link is open). */
  send(id: string, frame: PhoneFrame): boolean {
    const e = this.entries.get(id);
    if (!e || e.state.phase !== 'open') return false;
    e.transport.send(frame);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  // ---- each link

  private seenOf(c: PhoneComputer): Pick<ComputerLinkState, 'lastSeen'> {
    const at = Math.max(this.seen[c.id] ?? 0, c.lastSeen ?? 0);
    return at ? { lastSeen: at } : {};
  }

  private add(c: PhoneComputer): void {
    const transport = this.opts.make(c);
    const e: Entry = { computer: c, transport, offs: [], state: { computer: c, phase: 'idle', ...this.seenOf(c) }, attempt: 0 };
    e.offs.push(
      transport.onPhase((phase, detail) => this.onPhase(e, phase, detail)),
      transport.onFrame((f) => this.onFrame(e, f)),
    );
    this.entries.set(c.id, e);
    if (this.active) this.dial(e);
  }

  private drop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.clearRetry(e);
    for (const off of e.offs) off();
    if (e.state.phase === 'open') {
      e.transport.send({ t: 'bye' });
      this.opts.onDown?.(id);
    }
    e.transport.dispose();
  }

  private dial(e: Entry): void {
    this.clearRetry(e);
    e.transport.open(this.opts.hello(e.computer), hintsOf(e.computer));
  }

  private update(e: Entry, patch: Partial<ComputerLinkState>): void {
    e.state = { ...e.state, ...patch };
    this.opts.onChange?.();
  }

  private onPhase(e: Entry, phase: LinkPhase, detail?: string): void {
    if (this.entries.get(e.computer.id) !== e) return;
    const next: ComputerPhase = phase === 'unreachable' ? 'asleep' : phase;
    if (next === 'open') {
      e.attempt = 0;
      this.seen = { ...this.seen, [e.computer.id]: this.now() };
      this.keep();
      this.update(e, { phase: next, detail: undefined, lastSeen: this.seen[e.computer.id] });
      // Kept while away: it hears so, and sends nudges only.
      if (!this.active && this.kept === e.computer.id) {
        e.transport.send({ t: 'focus', on: false });
        e.transport.send({ t: 'sub', topics: [] });
        return;
      }
      this.opts.onOpen?.(e.computer.id);
      return;
    }
    // Leaving open: it was there until just now.
    if (e.state.phase === 'open') this.opts.onDown?.(e.computer.id);
    if (e.state.phase === 'open') {
      this.seen = { ...this.seen, [e.computer.id]: this.now() };
      this.keep();
    }
    this.update(e, { phase: next, ...(detail ? { detail } : { detail: undefined }), ...this.seenOf(e.computer) });
    if (next === 'closed' || next === 'asleep') this.scheduleRetry(e);
  }

  private onFrame(e: Entry, f: MacFrame): void {
    if (this.entries.get(e.computer.id) !== e) return;
    if (f.t === 'welcome') this.update(e, { mac: f.mac, proto: f.v });
    // A computer's own list of computers is not the phone's: only your Mac's says where they are.
    if (f.t === 'computers') return;
    if (f.t === 'bye') this.update(e, { phase: 'closed', detail: f.reason });
    this.opts.onFrame?.(e.computer.id, f);
  }

  /** While you look, a link that dropped (or a computer that didn't answer) is dialed again, backing off. */
  private scheduleRetry(e: Entry): void {
    this.clearRetry(e);
    const phase = e.state.phase === 'asleep' ? 'unreachable' : 'closed';
    const keptAway = !this.active && this.kept === e.computer.id;
    const fast = retryDelay({ phase, active: this.active || keptAway, attempt: e.attempt }, this.opts.random?.() ?? Math.random());
    // Away, after the quick ones: every two minutes, as the Mac's kept link does.
    const delay = fast !== undefined && keptAway && e.attempt >= RETRY_LIMIT ? AWAY_RETRY_MS : fast;
    if (delay === undefined) return;
    e.retry = setTimeout(() => {
      e.retry = undefined;
      if (!(this.active || this.kept === e.computer.id) || this.entries.get(e.computer.id) !== e) return;
      if (e.state.phase !== 'closed' && e.state.phase !== 'asleep') return;
      e.attempt++;
      this.dial(e);
    }, delay);
  }

  private clearRetry(e: Entry): void {
    if (e.retry) clearTimeout(e.retry);
    e.retry = undefined;
  }

  private keep(): void {
    const list = [...this.entries.values()].map((e) => e.computer);
    const ids = new Set(list.map((c) => c.id));
    this.seen = Object.fromEntries(Object.entries(this.seen).filter(([id]) => ids.has(id)));
    this.opts.save?.({ list, seen: this.seen });
  }
}
