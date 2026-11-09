import { AppState, type AppStateStatus, Linking, Platform } from 'react-native';
import { fromB64, fromUtf8, toB64 } from './b64';
import { kv } from './kv';
import { BareTransport } from './link/bare';
import { ComputerLinks, type ComputerLinkState, type KeptComputers } from './link/computers';
import { ComputerWork, type ComputerView } from './link/computer-work';
import { needRoute, placeNeeds } from './link/needs';
import { type Call, calls } from './link/calls';
import { DemoTransport } from './link/demo/transport';
import { BACKGROUND_GRACE_MS, COMPANION_PIECE, COMPANION_PROTO, compatible, SINCE, MAX_UPLOAD_BYTES, isMacTopic, type MacFrame, type NeedsYou, type OutputView, type HomeView, type PhoneComputer, type PhoneOp, type Topic, viewSchema } from './link/protocol';
import { controlNote, controlState, mirrorAck, onAccessibilityChange, onControlStop, phoneAllowed, phoneControlAvailable, runOp, setPhoneAllowed, watchAdb, watchMirror } from './phone';
import { type Diagnosis, type PairRefusal, diagnose } from './link/diagnose';
import { checkOnline } from './link/online';
import { graceExpired, onResume, PROBE_TIMEOUT_MS, RETRY_LIMIT, retryDelay } from './link/resume';
import { notifyNudge, stayOn, stayService } from './stay';
import type { Attempt, DeviceSecret, LinkHints, LinkPathName, LinkPhase, Pairing } from './link/rpc';
import type { PairInput, PairStep, PathInfo, PhaseInfo, Transport } from './link/transport';
import { secure } from './secure';
import { Assembly, MAX_SAVE_BYTES, PIECE_TIMEOUT_MS } from './pieces';
import { fileSink, memorySink, type Sink } from './sink';
import { mediaPath } from './media';

/**
 * The phone's one store: which Mac, the link's state, the views on screen (and the last ones,
 * cached for when your Mac is asleep), calls and the outbox, files fetched by ref. Screens read it
 * through lib/hooks.ts (useSyncExternalStore), so a view arriving re-renders only what shows it.
 *
 * Battery (docs/companion.md): the link opens when the app comes to the front and closes
 * BACKGROUND_GRACE_MS after it leaves. Nothing here polls; what changes comes from the Mac.
 */

export type Mode = 'demo' | 'bare';
export interface LinkState {
  readonly mode?: Mode;
  /** idle: not paired; dialing; open; asleep: tried, the Mac doesn't answer; closed: in the background. */
  readonly phase: 'idle' | LinkPhase | 'asleep';
  readonly detail?: string;
  readonly mac?: { name: string; version: string };
  readonly me?: { name: string; peerId: string };
  /** The two sides can't talk: whose update would fix it. */
  readonly outdated?: 'mac' | 'app';
  /** The Mac's protocol version (its minor says what it has: SINCE). */
  readonly proto?: { major: number; minor: number };
  readonly pairing?: Pairing;
  readonly ready: boolean;
  /** Why it can't connect, in plain words (the away band and its "Why?" sheet). */
  readonly diagnosis?: Diagnosis;
  /** How the open link got through, and what was tried (Settings › Advanced). */
  readonly path?: LinkPathName;
  readonly tried?: readonly Attempt[];
}

/** Relay URLs kept (newest first). */
const RELAYS_KEPT = 3;

export interface CachedView<T = unknown> {
  readonly data: T;
  readonly rev: number;
  /** When it arrived (for "as of 10:42"). */
  readonly at: number;
  /** From the cache, not (yet) from the Mac this session. */
  readonly stale: boolean;
}

export interface OutboxItem {
  readonly id: string;
  readonly call: Call;
  readonly at: number;
}

export interface FileState {
  readonly status: 'loading' | 'ready' | 'error';
  /** Pictures: a file:// URI in the cache (full pictures on the phone) or a data: URI. */
  readonly uri?: string;
  /** Text files: what has come so far. */
  readonly text?: string;
  /** Bytes received, and the file's size on the Mac. */
  readonly got: number;
  readonly size?: number;
  readonly mime?: string;
  readonly error?: string;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone?: 'ok' | 'warn' | 'error' | 'info';
  readonly topic?: Topic;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
/** A terminal's output or status, as the Mac sends it (1.7). */
export type TermFrame = Extract<MacFrame, { t: 'term_data' | 'term_status' }>;
/** A fetch in flight. Pictures come piece by piece (`asm` asks for the next), into `sink`; `timer` fails it if a piece doesn't come. */
type Fetch = { key: string; ref: string; variant: 'thumb' | 'full' | 'text'; parts: string[]; base: string; got: number; asm?: Assembly; sink?: Sink; timer?: ReturnType<typeof setTimeout>; save?: Saving };
/** A copy being fetched to save on the phone (lib/saved.ts): it ends one way or the other. */
type Saving = { resolve: (uri: string) => void; reject: (e: Error) => void };

const APP = 'beluga-companion/0.16.0';

/** Your friends' screens: what your Always On has while your Mac is away (BLG-850). */
export const isFriendsTopic = (topic: string): boolean => topic === 'people' || topic === 'chats' || topic.startsWith('chat:');
const PLATFORM: 'android' | 'ios' = Platform.OS === 'ios' ? 'ios' : 'android';

class Store {
  private transport: Transport | undefined;
  /** Your computers, each linked by itself (BLG-809): they answer while your Mac sleeps. */
  private computerLinks: ComputerLinks | undefined;
  /** What the phone shows of each computer: its views (kept) and calls on its link (BLG-810). */
  private computerWork: ComputerWork | undefined;
  private computerFrames = new Set<(id: string, frame: MacFrame) => void>();
  private unsubs: (() => void)[] = [];
  private state: LinkState = { phase: 'idle', ready: false };
  private views = new Map<string, CachedView>();
  private subCounts = new Map<Topic, number>();
  private subTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Map<number, Pending>();
  private fetches = new Map<number, Fetch>();
  private files = new Map<string, FileState>();
  private deferred = new Map<string, { ref: string; variant: 'thumb' | 'full' | 'text'; more: boolean }>();
  private outbox: OutboxItem[] = kv.get<OutboxItem[]>('outbox') ?? [];
  private hidden = new Set<string>();
  private latest = new Map<string, OutputView>();
  private toasts: Toast[] = [];
  private seq = 1;
  /** The Mac said welcome on this link (calls may go; they're answered). */
  private welcomed = false;
  private grace: ReturnType<typeof setTimeout> | undefined;
  /** The app is in front (AppState), and since when it's been away (the wall clock: BLG-105). */
  private active = false;
  private awayAt: number | undefined;
  /** When the dial in flight began; whether a check of the open link is out. */
  private dialingSince: number | undefined;
  private probing = false;
  /** One automatic retry at a time, backing off (lib/link/resume.ts retryDelay). */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  /** Away with Stay connected on (BLG-128): the link stays open, the views are off, nudges notify. */
  private stayingAway = false;
  private listeners = new Map<string, Set<() => void>>();
  private snapshots = new Map<string, unknown>();
  /** What the image viewer shows, and where it opened from (for the transition back). */
  gallery: { items: OutputView[]; index: number; origin?: { x: number; y: number; w: number; h: number }; topic?: Topic } = { items: [], index: 0 };

  // ---- subscribe (for useSyncExternalStore)

  subscribe(key: string, fn: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => void set!.delete(fn);
  }
  private emit(key: string): void {
    this.snapshots.delete(key);
    for (const fn of [...(this.listeners.get(key) ?? [])]) fn();
  }
  /** Stable snapshots: the same object until its key changes. */
  snapshot<T>(key: string, make: () => T): T {
    if (!this.snapshots.has(key)) this.snapshots.set(key, make());
    return this.snapshots.get(key) as T;
  }

  getState(): LinkState {
    return this.state;
  }
  private setState(patch: Partial<LinkState>): void {
    const was = this.state.phase;
    this.state = { ...this.state, ...patch };
    if (this.state.phase !== was) this.stayNote();
    this.emit('state');
    if (this.state.phase !== was && (was === 'open' || this.state.phase === 'open')) this.friendsMoved();
  }

  // ---- starting up, pairing, signing out

  private booted = false;
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const mode = kv.get<Mode>('mode');
    const pairing = mode === 'bare' ? await secure.get<Pairing>('pairing') : undefined;
    for (const [topic, v] of Object.entries(kv.get<Record<string, { data: unknown; rev: number; at: number }>>('views') ?? {})) {
      this.views.set(topic, { ...v, stale: true });
    }
    if (mode === 'demo' || (mode === 'bare' && pairing)) this.use(mode, pairing);
    this.setState({ ready: true });
    this.active = AppState.currentState === 'active';
    AppState.addEventListener('change', (s) => this.onAppState(s));
    // Opened by a link (or a notification's) while in the background: back in front, so link now.
    // AppState says so too; whichever comes first dials, the other finds it dialing (single flight).
    Linking.addEventListener('url', () => this.foreground());
    if (mode && AppState.currentState === 'active') this.foreground();
    else if (mode === 'bare' && stayOn()) this.stayAway();
    // Your Mac using this phone (BLG-150): start watching the service and debugging port if allowed.
    if (mode === 'bare' && phoneControlAvailable()) this.controlSet(phoneAllowed());
  }

  private use(mode: Mode, pairing?: Pairing): void {
    this.dropTransport();
    const t: Transport = mode === 'demo' ? new DemoTransport() : new BareTransport(async () => {
      const p = await secure.get<Pairing>('pairing');
      const s = await secure.get<DeviceSecret>('device-secret');
      return p && s ? { pairing: p, secret: s } : undefined;
    });
    this.transport = t;
    if (mode === 'bare') this.computerLinks = this.linkComputers();
    if (t instanceof DemoTransport && kv.get<boolean>('demo-asleep')) t.setAsleep(true);
    this.unsubs = [t.onFrame((f) => this.onFrame(f)), t.onPhase((p, d, i) => this.onPhase(p, d, i)), (t as Transport).onPath?.((i: PathInfo) => this.onPath(i)) ?? (() => {})];
    this.setState({ mode, pairing, phase: 'closed' });
  }

  /**
   * A link per computer of yours (BLG-809), with the same certificate and keys as the Mac's link:
   * only the address it dials (and its relays) are that computer's.
   */
  private linkComputers(): ComputerLinks {
    const work = new ComputerWork({
      send: (id, f) => this.computerLinks?.send(id, f) ?? false,
      proto: (id) => this.computerLinks?.get(id)?.proto,
      name: (id) => this.computerLinks?.get(id)?.computer.name,
      emit: (key) => {
        this.emit(key);
        if (key.endsWith('|home')) this.emit('computer-needs');
        // Your Always On's friends views stand in for the Mac's while it's away (BLG-850): their screens re-read.
        const topic = key.slice(key.indexOf('|') + 1) as Topic;
        if (isFriendsTopic(topic)) this.emit(`view:${topic}`);
      },
      extra: (id) => (id === this.alwaysOnId() ? [...this.subCounts.keys()].filter(isFriendsTopic) : []),
      load: () => kv.get('computer-views'),
      save: (kept) => kv.set('computer-views', kept),
    });
    this.computerWork = work;
    return new ComputerLinks({
      make: (c: PhoneComputer) =>
        new BareTransport(async () => {
          const p = await secure.get<Pairing>('pairing');
          const s = await secure.get<DeviceSecret>('device-secret');
          return p && s ? { pairing: { cert: p.cert, address: c.address, macName: c.name, ...(p.me ? { me: p.me } : {}), ...(c.relays[0] ? { relay: c.relays[0] } : {}) }, secret: s } : undefined;
        }),
      hello: (c) => ({ t: 'hello', v: { ...COMPANION_PROTO }, app: APP, platform: PLATFORM, topics: work.topics(c.id) }),
      load: () => kv.get<KeptComputers>('computers'),
      save: (kept) => kv.set('computers', kept),
      primary: () => this.state.pairing?.address,
      onChange: () => {
        this.emit('computers');
        this.emit('computer-needs');
        this.friendsMoved();
      },
      onOpen: (id) => work.opened(id),
      onDown: (id) => work.closed(id),
      onGone: (id) => work.forget(id),
      onFrame: (id, f) => {
        if (!work.take(id, f)) this.onComputerFrame(id, f);
      },
    });
  }

  /** A computer's own frame: what needs you there is said as the Mac's is; the rest goes to who listens. */
  private onComputerFrame(id: string, f: MacFrame): void {
    if (f.t === 'nudge') {
      const name = this.computerLinks?.get(id)?.computer.name;
      const titled = name ? { ...f, title: `${f.title} · ${name}`.slice(0, 200) } : f;
      if (!this.active) void notifyNudge(titled);
      else this.toast({ text: `${titled.title} · ${f.body}`, tone: f.kind === 'needsYou' ? 'warn' : 'info' });
      return;
    }
    for (const fn of [...this.computerFrames]) fn(id, f);
  }

  /** Your computers and how each link is (stable until one changes). */
  computers(): readonly ComputerLinkState[] {
    return this.snapshot('computers', () => this.computerLinks?.states() ?? []);
  }

  /** Frames from your computers' links (views, results), for the screens that show them. */
  onComputer(fn: (id: string, frame: MacFrame) => void): () => void {
    this.computerFrames.add(fn);
    return () => void this.computerFrames.delete(fn);
  }

  /** A computer's topic on screen: subscribed on its own link while mounted. */
  watchOn(on: string, topic: Topic): () => void {
    return this.computerWork?.watch(on, topic) ?? (() => undefined);
  }

  viewOn<T>(on: string, topic: Topic): ComputerView<T> | undefined {
    return this.computerWork?.view<T>(on, topic);
  }

  /** Does that computer have this (its own protocol's minor)? */
  supportsOn(on: string, what: keyof typeof SINCE): boolean {
    return this.computerWork?.supports(on, what) ?? false;
  }

  /** Every computer's needs-you, listed under ids of their own (answering goes to that computer). */
  computerNeeds(): readonly NeedsYou[] {
    return this.snapshot('computer-needs', () => {
      const work = this.computerWork;
      if (!work) return [];
      return this.computers().flatMap((c) => this.placeNeeds(c.computer.id, work.view<HomeView>(c.computer.id, 'home')?.data.needsYou));
    });
  }

  /** A computer's needs-you items, under ids of their own and saying which computer: answering one goes back there. */
  placeNeeds(on: string, items: readonly NeedsYou[] | undefined): NeedsYou[] {
    return placeNeeds(on, this.computerName(on), items);
  }

  // ---- friends with your Mac closed (BLG-850): your Always On has them

  /** Your Always On, when it's one of your computers. */
  private alwaysOnId(): string | undefined {
    return this.computerLinks?.states().find((s) => s.computer.alwaysOn)?.computer.id;
  }

  /**
   * Where your friends are reached now: your Mac while it answers, else your Always On while its
   * link is open (it runs your network); none: your Mac (its kept views, or waiting for it).
   */
  friendsOn(): string | undefined {
    if (this.state.phase === 'open') return undefined;
    const id = this.alwaysOnId();
    return id && this.linkedTo(id) ? id : undefined;
  }

  /** Where the friends views come from may have changed: their screens re-read, and your Always On hears what's on them. */
  private friendsMoved(): void {
    const id = this.alwaysOnId();
    if (id) this.computerWork?.opened(id);
    for (const t of this.subCounts.keys()) if (isFriendsTopic(t)) this.emit(`view:${t}`);
  }

  /** That computer's link is open now. */
  linkedTo(on: string): boolean {
    return this.computerLinks?.get(on)?.phase === 'open';
  }

  computerName(on: string): string | undefined {
    return this.computerLinks?.get(on)?.computer.name;
  }

  /** Which computer a needs-you item is from (none: your Mac). */
  needOn(id: string): string | undefined {
    return needRoute(id)?.on;
  }

  /** One frame to one of your computers (false: its link isn't open). */
  sendToComputer(id: string, frame: Parameters<ComputerLinks['send']>[1]): boolean {
    return this.computerLinks?.send(id, frame) ?? false;
  }

  private dropTransport(): void {
    this.computerLinks?.dispose();
    this.computerLinks = undefined;
    this.computerWork = undefined;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.transport?.dispose();
    this.transport = undefined;
    this.clearRetry();
    this.probing = false;
    this.dialingSince = undefined;
  }

  /** Pair with a Mac (or start the demo, `mode: 'demo'`). */
  pair(mode: Mode, input: Omit<PairInput, 'platform'>, onStep: (step: PairStep) => void): { cancel(): void } {
    const t: Transport = mode === 'demo' ? new DemoTransport() : new BareTransport(async () => undefined);
    const offPath = t.onPath?.((i) => this.onPath(i));
    const run = t.pair({ ...input, platform: PLATFORM, hints: this.hints() }, (step) => {
      if (step.step === 'failed' && !step.diagnosis) {
        // Say what went wrong in words: check the phone is online first, so nothing else is blamed for that.
        const known = step.refusal ? undefined : step.report;
        void (known ? checkOnline() : Promise.resolve(undefined)).then((online) =>
          onStep({ ...step, diagnosis: diagnose({ stage: 'pair', ...(online !== undefined ? { online } : {}), ...(step.report ? { report: step.report } : {}), ...(step.refusal ? { refusal: step.refusal as PairRefusal } : {}), reason: step.reason }) }),
        );
        return;
      }
      if (step.step === 'paired') {
        void (async () => {
          if (mode === 'bare') {
            await secure.set('pairing', step.pairing);
            await secure.set('device-secret', step.secret);
          }
          kv.set('mode', mode);
          offPath?.();
          t.dispose();
          this.use(mode, step.pairing);
          this.foreground();
          onStep(step);
        })();
        return;
      }
      onStep(step);
    });
    return { cancel: () => (run.cancel(), t.dispose()) };
  }

  /**
   * Sign out: the Mac removes this phone's certificate (companion.signOut), then the phone forgets
   * its keys, the pairing and every cached view. Away from the Mac, the local part still happens
   * (remove the phone on the Mac too: Settings › Phone).
   */
  async signOut(): Promise<{ onMac: boolean }> {
    let onMac = false;
    if (this.state.phase === 'open') onMac = await this.call(calls.signOut(), { queue: false }).then(() => true, () => false);
    this.transport?.send({ t: 'bye' });
    this.dropTransport();
    this.stayingAway = false;
    stayService(undefined);
    await secure.remove('pairing');
    await secure.remove('device-secret');
    kv.clear();
    this.views.clear();
    this.files.clear();
    this.outbox = [];
    this.hidden.clear();
    this.snapshots.clear();
    this.state = { phase: 'idle', ready: true };
    for (const key of this.listeners.keys()) this.emit(key);
    return { onMac };
  }

  /** The demo Mac falls asleep (or wakes): to see the phone's "away" state. Kept across launches. */
  setDemoAsleep(asleep: boolean): void {
    kv.set('demo-asleep', asleep);
    this.demo?.setAsleep(asleep);
    if (!asleep) this.retry();
  }

  get demo(): DemoTransport | undefined {
    return this.transport instanceof DemoTransport ? this.transport : undefined;
  }

  // ---- the link's life: open while you look

  private onAppState(s: AppStateStatus): void {
    if (s === 'active') this.foreground();
    else if (s === 'background') this.background();
  }

  /**
   * The app is in front again (or you asked to try again): make sure the link is really there.
   * Decided by lib/link/resume.ts: an open link is pinged and replaced if it doesn't answer; one
   * left open past the grace (Android froze it instead of closing it) is replaced at once; a dial
   * under way is left alone; anything else dials now, with the retries' backoff started afresh.
   */
  foreground(): void {
    this.active = true;
    if (this.grace) clearTimeout(this.grace);
    this.grace = undefined;
    const stayed = this.stayingAway;
    this.stayingAway = false;
    // In front is the only time Android lets the service start.
    this.stayNote(true);
    // Kept open on purpose while away: it isn't stale for having been away, only checked.
    const awayAt = stayed ? undefined : this.awayAt;
    this.awayAt = undefined;
    this.clearRetry();
    this.retryAttempt = 0;
    // Your computers are linked whether or not your Mac answers.
    this.computerLinks?.open();
    const t = this.transport;
    if (!t) return;
    const next = onResume({ phase: this.state.phase, now: Date.now(), ...(awayAt !== undefined ? { awayAt } : {}), ...(this.dialingSince !== undefined ? { dialingSince: this.dialingSince } : {}), probing: this.probing });
    if (next.do === 'none') return;
    if (next.do === 'probe') {
      t.send({ t: 'focus', on: true });
      if (stayed) t.send({ t: 'sub', topics: this.topics() });
      // The Mac stops a terminal's stream while the app is away: its screen draws afresh now.
      this.reattachTerms();
      this.probe();
      return;
    }
    this.dial(next.replace);
  }

  /** Dial now; `replace`: drop the link or dial there is first (it can't be trusted). */
  private dial(replace: boolean): void {
    const t = this.transport;
    if (!t) return;
    this.clearRetry();
    if (replace && (this.state.phase === 'open' || this.state.phase === 'dialing')) t.close('stale');
    this.dialingSince = Date.now();
    t.open({ t: 'hello', v: { ...COMPANION_PROTO }, app: APP, platform: PLATFORM, topics: this.topics() }, this.hints());
  }

  /** Ping the open link; if it doesn't answer in time it's half-open: dial a new one. */
  private probe(): void {
    const t = this.transport;
    if (!t?.probe || this.probing) return;
    this.probing = true;
    void t.probe(PROBE_TIMEOUT_MS).then(
      (ok) => {
        this.probing = false;
        if (ok || t !== this.transport || !this.active) return;
        if (this.state.phase === 'open' || this.state.phase === 'closed') this.dial(true);
      },
      () => void (this.probing = false),
    );
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** The link dropped, or the Mac didn't answer, while you look: try again by itself, backing off. */
  private scheduleRetry(): void {
    this.clearRetry();
    const staying = this.stayingAway && !this.active;
    const fast = retryDelay({ phase: this.state.phase, active: this.active || staying, attempt: this.retryAttempt }, Math.random());
    // Away, after the quick ones: every two minutes (the Mac may be asleep for the night).
    const delay = fast !== undefined && staying && this.retryAttempt >= RETRY_LIMIT ? 120_000 : fast;
    if (delay === undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const p = this.state.phase;
      if (!(this.active || this.stayingAway) || !this.transport || (p !== 'closed' && p !== 'asleep')) return;
      this.retryAttempt++;
      this.dial(false);
    }, delay);
  }

  // ---- reaching the Mac on any network (docs/companion.md, "Any network")

  /** The relays seen and the way that worked per network (kv: nothing secret). */
  private hints(): LinkHints {
    const h = kv.get<LinkHints>('link-hints') ?? { relays: [], prefer: {} };
    const paired = this.state.pairing?.relay;
    return paired && !h.relays.includes(paired) ? { ...h, relays: [...h.relays, paired] } : h;
  }

  private keepRelay(relay: string | undefined): void {
    if (!relay) return;
    const h = this.hints();
    if (h.relays[0] === relay) return;
    kv.set('link-hints', { ...h, relays: [relay, ...h.relays.filter((r) => r !== relay)].slice(0, RELAYS_KEPT) });
  }

  private onPath(i: PathInfo): void {
    const h = this.hints();
    kv.set('link-hints', { relays: i.relay ? [i.relay, ...h.relays.filter((r) => r !== i.relay)].slice(0, RELAYS_KEPT) : h.relays, prefer: i.network ? { ...h.prefer, [i.network]: i.way } : h.prefer });
    this.setState({ path: i.path, tried: i.tried });
  }

  background(): void {
    this.active = false;
    this.clearRetry();
    this.awayAt ??= Date.now();
    if (!this.transport || this.grace) return;
    if (this.state.mode === 'bare' && stayOn()) return this.stayAway();
    if (this.state.phase === 'open') this.transport.send({ t: 'focus', on: false });
    this.armGrace(BACKGROUND_GRACE_MS);
  }

  /**
   * Stay connected (BLG-128): away, the link stays open with nothing on screen, so the Mac sends
   * only nudges (and pings come and go), and the tiles for Home-screen widgets when any are placed
   * (BLG-361); a link that drops is dialed again, slowly.
   */
  private stayAway(): void {
    this.stayingAway = true;
    this.active = false;
    this.awayAt ??= Date.now();
    // Your Always On stays linked too: with your Mac closed, your friends' messages and requests notify from there (BLG-850).
    this.computerLinks?.stayAway(this.alwaysOnId());
    if (this.state.phase === 'open') {
      this.transport?.send({ t: 'focus', on: false });
      this.transport?.send({ t: 'sub', topics: this.topics() });
    } else if (this.state.phase !== 'dialing') this.dial(false);
    this.stayNote();
  }

  /** Turned on or off in Settings: the service follows, and so does the link if the app is away. */
  staySet(): void {
    if (!stayOn()) {
      this.stayingAway = false;
      stayService(undefined);
      if (!this.active) this.computerLinks?.close('background');
      return;
    }
    this.stayNote(true);
  }

  /** The service's quiet line says how the link is. */
  private stayNote(force = false): void {
    if (this.state.mode !== 'bare' || !stayOn()) return stayService(undefined);
    stayService(this.state.phase === 'open' ? 'Connected to your Mac' : 'Reconnecting to your Mac…', force);
  }

  private armGrace(ms: number): void {
    this.grace = setTimeout(() => {
      this.grace = undefined;
      // Android runs a timer paused in the background late, often just as the app comes back:
      // close only if it's still away, and long enough by the clock.
      if (this.active || this.awayAt === undefined) return;
      const now = Date.now();
      if (!graceExpired({ active: this.active, awayAt: this.awayAt, now })) return this.armGrace(this.awayAt + BACKGROUND_GRACE_MS - now);
      this.transport?.send({ t: 'bye' });
      this.transport?.close('background');
      this.computerLinks?.close('background');
    }, ms);
  }

  /** Try again now (the "asleep" banner's button). */
  retry(): void {
    this.foreground();
  }

  private onPhase(phase: LinkPhase, detail?: string, info?: PhaseInfo): void {
    if (phase === 'dialing') {
      if (this.state.phase !== 'dialing' || this.dialingSince === undefined) this.dialingSince = Date.now();
      this.clearRetry();
    } else this.dialingSince = undefined;
    if (phase === 'open') {
      this.retryAttempt = 0;
      this.clearRetry();
      this.setState({ phase, detail: undefined, diagnosis: undefined });
      // Screens may have changed while dialing: say what's on screen now.
      this.transport?.send({ t: 'sub', topics: this.topics() });
      this.reattachTerms();
      const wanted = [...this.deferred.values()];
      this.deferred.clear();
      for (const w of wanted) {
        const key = `${w.ref}#${w.variant}`;
        if (this.files.get(key)?.status !== 'ready' || w.more) {
          this.files.delete(key);
          this.fetch(w.ref, w.variant, w.more);
        }
      }
      return;
    }
    if (phase === 'unreachable') {
      this.setState({ phase: 'asleep', detail, path: undefined });
      // In words, once we know whether the phone itself is online.
      void checkOnline().then((online) => {
        if (this.state.phase !== 'asleep') return;
        const d = diagnose({ stage: 'link', online, ...(info?.report ? { report: info.report } : {}), ...(detail ? { reason: detail } : {}) });
        // Removed on the Mac: trying again won't help, pairing again will (the banner says so).
        if (!d.retry) this.clearRetry();
        this.setState({ diagnosis: d });
      });
    } else {
      // Dialing again keeps saying what was wrong (the banner stays put while it retries by itself).
      const d = phase === 'dialing' && this.state.diagnosis?.auto ? this.state.diagnosis : phase === 'refused' ? diagnose({ stage: 'link', ...(info?.code !== undefined ? { closeCode: info.code } : {}), ...(detail ? { reason: detail } : {}) }) : undefined;
      this.setState({ phase, detail, path: phase === 'closed' ? this.state.path : undefined, diagnosis: d && (d.problem !== 'unknown' || phase === 'dialing') ? d : undefined });
    }
    this.welcomed = false;
    if (phase === 'closed' || phase === 'unreachable') this.scheduleRetry();
    // Calls in flight won't be answered. Marked `lost`: the Mac may or may not have done it
    // (lib/sends.ts checks the Mac's view before it says either).
    for (const [, p] of this.pending) p.reject(Object.assign(new Error('The link closed.'), { lost: true }));
    this.pending.clear();
    for (const [id, f] of this.fetches) {
      this.fetches.delete(id);
      this.endFetch(f);
      if (f.save) {
        this.failSave(f, 'Your Mac went away. Try again.');
        continue;
      }
      if (this.files.get(f.key)?.status === 'loading') {
        this.deferred.set(f.key, { ref: f.ref, variant: f.variant, more: false });
        this.setFile(f.key, { status: 'error', got: 0, error: 'Your Mac is away' });
      }
    }
  }

  private onFrame(f: MacFrame): void {
    switch (f.t) {
      case 'welcome': {
        const ok = compatible(COMPANION_PROTO, f.v, f.min);
        const outdated = ok ? undefined : COMPANION_PROTO.major < f.min.major ? ('app' as const) : ('mac' as const);
        const older = this.state.proto?.minor !== f.v.minor;
        this.setState({ mac: f.mac, me: f.me, outdated, proto: f.v });
        this.keepRelay(f.relay);
        // What's on screen again, now that it's known what this Mac has (an older one drops a `sub` naming a topic it doesn't know).
        if (older) this.transport?.send({ t: 'sub', topics: this.topics() });
        this.welcomed = !outdated;
        if (!outdated) this.flushOutbox();
        if (!outdated) this.reportControl();
        this.emit('linked');
        return;
      }
      case 'view': {
        const parsed = viewSchema(f.topic).safeParse(f.data);
        if (!parsed.success) {
          if (__DEV__) console.warn('[view] does not match protocol.ts', f.topic, parsed.error.issues.slice(0, 3));
          return;
        }
        const v: CachedView = { data: parsed.data, rev: f.rev, at: Date.now(), stale: false };
        this.views.set(f.topic, v);
        this.noteOutputs(parsed.data);
        // Needs-you you've answered come back hidden until the Mac drops them.
        this.emit(`view:${f.topic}`);
        this.persistViews();
        return;
      }
      case 'result': {
        const p = this.pending.get(f.id);
        if (p) {
          this.pending.delete(f.id);
          if (f.ok) p.resolve(f.value);
          else p.reject(new Error(f.error ?? 'Your Mac said no.'));
          return;
        }
        const fetch = this.fetches.get(f.id);
        if (fetch?.save && !f.ok) {
          this.fetches.delete(f.id);
          this.endFetch(fetch);
          this.failSave(fetch, f.error ?? 'Not available');
        } else if (fetch && !f.ok) {
          this.fetches.delete(f.id);
          this.endFetch(fetch);
          this.setFile(fetch.key, { status: 'error', got: 0, error: f.error ?? 'Not available' });
        }
        return;
      }
      case 'chunk':
        this.onChunk(f);
        return;
      case 'term_data':
      case 'term_status':
        for (const fn of [...(this.termListeners.get(f.term) ?? [])]) fn(f);
        return;
      case 'req':
        // The Mac wants the phone to act (BLG-150): the native side does it, the reply goes back.
        void runOp(f.op as PhoneOp, f.args as Record<string, unknown>).then(
          (value) => this.transport?.send({ t: 'reply', id: f.id, ok: true, value }),
          (err: unknown) => this.transport?.send({ t: 'reply', id: f.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        return;
      case 'vid_ack':
        mirrorAck(f.seq);
        return;
      case 'tun_open':
      case 'tun_data':
      case 'tun_ack':
      case 'tun_close':
        // The adb tunnel lives in the worklet (it has bare-tcp); nothing for the screens to do.
        return;
      case 'nudge':
        if (!this.active) {
          void notifyNudge(f);
          return;
        }
        this.toast({ text: `${f.title} · ${f.body}`, tone: f.kind === 'needsYou' ? 'warn' : 'info', topic: f.topic });
        return;
      case 'bye':
        this.setState({ phase: 'closed', detail: f.reason });
        return;
      case 'computers':
        // Your Mac says where your computers are (1.49): each is linked by itself from now on.
        this.computerLinks?.setList(f.list);
        return;
    }
  }

  /** Linked and welcomed: a call now goes, and is answered (unless the link drops). */
  get linked(): boolean {
    return this.welcomed && this.state.phase === 'open' && Boolean(this.transport);
  }

  // ---- your Mac using this phone (BLG-150)

  private offAcc?: () => void;
  private offAdb?: () => void;
  private offStop?: () => void;
  private offMirror?: () => void;

  /** Tell the Mac what this phone allows and how it can be reached (only to a Mac that supports it). */
  private reportControl(): void {
    if (!phoneControlAvailable() || !this.supports('control') || this.state.phase !== 'open') return;
    this.transport?.send({ t: 'control', state: controlState() });
  }

  /**
   * The user turned "Let your Mac use this phone" on or off (Settings): watch the Accessibility
   * service and this phone's Wireless-debugging port while on, and tell the Mac the new state.
   */
  controlSet(allowed: boolean): void {
    if (!phoneControlAvailable()) return;
    this.offAcc ??= onAccessibilityChange(() => this.reportControl());
    // The screen's video for the Mac's mirror (1.18), piece by piece as the encoder makes it.
    this.offMirror ??= watchMirror((f) => this.transport?.send(f));
    this.offStop ??= onControlStop(() => {
      setPhoneAllowed(false);
      this.controlSet(false);
    });
    this.offAdb?.();
    this.offAdb = watchAdb(allowed, () => this.reportControl());
    // The ongoing "Your Mac is using this phone" notice (with Stop) shows while control is allowed.
    controlNote(allowed, 'Your agent can act on this phone');
    this.reportControl();
  }

  /** The Wireless-debugging pairing code the user typed, sent to the Mac for `adb pair`. */
  sendAdbCode(code: string): void {
    this.transport?.send({ t: 'adb_code', code });
  }

  // ---- views

  /** The topics on screen right now (what the Mac should send); away, only the ones kept while away. */
  private topics(): Topic[] {
    if (this.stayingAway) return [...this.awayTopics].filter(([t, wanted]) => wanted() && this.knows(t)).map(([t]) => t);
    return [...this.subCounts.keys()].filter((t) => this.knows(t)).slice(0, 16);
  }

  /** Topics that keep coming while away with Stay connected, as long as `wanted` says (the Home-screen widgets' tiles). */
  private awayTopics = new Map<Topic, () => boolean>();
  keepWhileAway(topic: Topic, wanted: () => boolean): void {
    this.awayTopics.set(topic, wanted);
  }

  /** Does the Mac have this (its protocol's minor, SINCE)? Before its welcome, only what every 1.x has. */
  supports(what: keyof typeof SINCE): boolean {
    const v = this.state.proto;
    if (!v) return this.state.mode === 'demo';
    return v.major > COMPANION_PROTO.major || (v.major === COMPANION_PROTO.major && v.minor >= SINCE[what]);
  }
  private knows(topic: Topic): boolean {
    if (isMacTopic(topic)) return this.supports('assistant');
    if (topic === 'sentinels' || topic.startsWith('sentinel:')) return this.supports('sentinel');
    if (topic.startsWith('dashboard:')) return this.supports('dashboard');
    if (topic === 'widgets') return this.supports('widgets');
    return topic === 'tasks' || topic.startsWith('task:') ? this.supports('tasks') : true;
  }

  // ---- projects' icons: by checksum, fetched once (companion.icon), kept across launches

  private icons = new Map<string, string>();
  private iconAsked = new Set<string>();
  /** A project's icon as a data: URI; undefined while it comes (it's asked for once), or without one. */
  cachedIcon(sum: string | undefined): string | undefined {
    if (!sum) return undefined;
    const have = this.icons.get(sum) ?? kv.get<string>(`icon:${sum}`);
    if (have) this.icons.set(sum, have);
    return have;
  }
  /** The icon, asking the Mac for it once when it isn't here yet. */
  icon(sum: string | undefined): string | undefined {
    if (!sum) return undefined;
    const have = this.cachedIcon(sum);
    if (have) return have;
    if (this.state.phase !== 'open' || this.iconAsked.has(sum) || !this.supports('icon')) return undefined;
    this.iconAsked.add(sum);
    this.call<{ sum: string; mime: string; b64: string }>(calls.icon(sum), { queue: false }).then(
      (r) => {
        if (!r?.b64) return;
        const uri = `data:${r.mime};base64,${r.b64}`;
        this.icons.set(sum, uri);
        kv.set(`icon:${sum}`, uri);
        this.emit(`icon:${sum}`);
      },
      () => this.iconAsked.delete(sum),
    );
    return undefined;
  }

  /** A screen shows `topic`: subscribe while it's mounted. */
  watch(topic: Topic): () => void {
    this.subCounts.set(topic, (this.subCounts.get(topic) ?? 0) + 1);
    this.syncSubs();
    return () => {
      const n = (this.subCounts.get(topic) ?? 1) - 1;
      if (n <= 0) this.subCounts.delete(topic);
      else this.subCounts.set(topic, n);
      this.syncSubs();
    };
  }
  private syncSubs(): void {
    // Coalesced: a screen change unmounts one topic and mounts another in the same moment.
    if (this.subTimer) return;
    this.subTimer = setTimeout(() => {
      this.subTimer = undefined;
      if (this.state.phase === 'open') this.transport?.send({ t: 'sub', topics: this.topics() });
      const ao = this.alwaysOnId();
      if (ao) this.computerWork?.opened(ao);
    }, 50);
  }

  view<T>(topic: Topic): CachedView<T> | undefined {
    const mine = this.views.get(topic) as CachedView<T> | undefined;
    // With your Mac away, your friends come from your Always On (BLG-850): its view, or its kept one when newer.
    const ao = isFriendsTopic(topic) && this.state.phase !== 'open' ? this.alwaysOnId() : undefined;
    const theirs = ao ? this.computerWork?.view<T>(ao, topic) : undefined;
    return theirs && (!mine || this.linkedTo(ao!) || theirs.at > mine.at) ? theirs : mine;
  }

  /** Every view kept now (on screen, or the last ones), newest first. */
  cachedViews(): Array<[Topic, CachedView]> {
    return [...this.views].sort((a, b) => b[1].at - a[1].at) as Array<[Topic, CachedView]>;
  }

  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistViews(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      // The list topics and the last few conversations; enough for "your Mac is asleep".
      const keep: Record<string, { data: unknown; rev: number; at: number }> = {};
      const entries = [...this.views].sort((a, b) => b[1].at - a[1].at).slice(0, 24);
      for (const [k, v] of entries) keep[k] = { data: v.data, rev: v.rev, at: v.at };
      kv.set('views', keep);
    }, 1000);
  }

  private noteOutputs(data: unknown): void {
    const walk = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      const o = x as Record<string, unknown>;
      if (typeof o.ref === 'string' && o.ref.startsWith('out:') && typeof o.kind === 'string') {
        const prev = this.latest.get(o.ref);
        this.latest.set(o.ref, o as unknown as OutputView);
        if (prev && prev.size !== o.size) this.emit(`out:${o.ref}`);
        return;
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(data);
  }

  /** The newest we know of an output (its size grows while a log is written). */
  output(ref: string): OutputView | undefined {
    return this.latest.get(ref);
  }

  // ---- needs you: answered ones hide at once

  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }
  hide(id: string, hidden = true): void {
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.emit('hidden');
  }

  // ---- calls and the outbox

  /** Make a call; while your Mac is away it waits in the outbox (and resolves `undefined`). */
  call<T = unknown>(c: Call, opts: { queue?: boolean; /** One of your computers: on its own link, never queued (BLG-810). */ on?: string } = {}): Promise<T | undefined> {
    // Your friends network with your Mac away: on your Always On's link (BLG-850).
    const on = opts.on ?? (c.method.startsWith('network.') ? this.friendsOn() : undefined);
    if (on) return this.computerWork ? this.computerWork.call<T>(on, c.method, c.args) : Promise.reject(new Error('That computer is away.'));
    if (this.state.phase !== 'open' || !this.transport) {
      if (opts.queue === false) return Promise.reject(new Error('Your Mac is away.'));
      this.outbox = [...this.outbox, { id: `o${Date.now()}${this.seq++}`, call: c, at: Date.now() }];
      kv.set('outbox', this.outbox);
      this.emit('outbox');
      this.toast({ text: `Queued for when your Mac wakes: ${c.label}`, tone: 'info' });
      return Promise.resolve(undefined);
    }
    const id = this.seq++;
    return new Promise<T | undefined>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport!.send({ t: 'call', id, method: c.method, args: [...c.args] });
    });
  }

  /**
   * Send a file to the Mac (`put`, pieces of COMPANION_PIECE in order, one id): → its `up:` ref,
   * for companion.ask / companion.post. Only while linked (a photo isn't queued).
   */
  async put(name: string, mime: string, b64: string): Promise<string> {
    const bytes = fromB64(b64);
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('That file is too big to send (up to 25 MB).');
    if (this.state.phase !== 'open' || !this.transport) throw new Error('Your Mac is away.');
    const id = this.seq++;
    for (let off = 0; ; off += COMPANION_PIECE) {
      const piece = bytes.subarray(off, off + COMPANION_PIECE);
      const eof = off + piece.length >= bytes.length;
      const value = (await new Promise<unknown>((resolve, reject) => {
        if (!this.transport) return reject(new Error('Your Mac is away.'));
        this.pending.set(id, { resolve, reject });
        this.transport.send({ t: 'put', id, name: name.slice(0, 200) || 'photo.jpg', mime: mime.slice(0, 100), size: bytes.length, off, b64: toB64(piece), eof });
      })) as { ref?: string } | undefined;
      if (eof) {
        if (!value?.ref) throw new Error("Your Mac didn't take the file.");
        return value.ref;
      }
    }
  }

  getOutbox(): OutboxItem[] {
    return this.outbox;
  }
  discard(id: string): void {
    this.outbox = this.outbox.filter((o) => o.id !== id);
    kv.set('outbox', this.outbox);
    this.emit('outbox');
  }
  private flushOutbox(): void {
    const items = this.outbox;
    if (!items.length) return;
    this.outbox = [];
    kv.set('outbox', this.outbox);
    this.emit('outbox');
    for (const item of items) {
      this.call(item.call, { queue: false }).then(
        () => this.toast({ text: `Sent: ${item.call.label}`, tone: 'ok' }),
        (e: Error) => this.toast({ text: `${item.call.label} failed: ${e.message}`, tone: 'error' }),
      );
    }
  }

  /**
   * Dismiss a needs-you item without answering it: gone here at once, and (a Mac with
   * SINCE.dismiss) gone on the Mac too and after a relink. An older Mac: hidden until the phone relinks.
   */
  dismiss(item: NeedsYou): void {
    this.hide(item.id);
    const route = needRoute(item.id);
    if (!(route ? this.supportsOn(route.on, 'dismiss') : this.supports('dismiss'))) return;
    this.call(calls.dismissNeed(route?.id ?? item.id), route ? { on: route.on } : {}).catch((e: Error) => {
      this.hide(item.id, false);
      this.toast({ text: e.message, tone: 'error' });
    });
  }

  /** Answer a needs-you item: hide it now, show it again if the Mac says no. */
  async answer(item: NeedsYou, c: Call, done: string): Promise<void> {
    this.hide(item.id);
    const on = needRoute(item.id)?.on;
    try {
      await this.call(c, on ? { on } : {});
      this.toast({ text: done, tone: 'ok' });
    } catch (e) {
      this.hide(item.id, false);
      this.toast({ text: (e as Error).message, tone: 'error' });
    }
  }

  // ---- files

  file(ref: string, variant: 'thumb' | 'full' | 'text' | 'save'): FileState | undefined {
    return this.files.get(`${ref}#${variant}`);
  }

  /** Fetch an output (cached: nothing is fetched twice). `more`: the next piece of a text file. */
  fetch(ref: string, variant: 'thumb' | 'full' | 'text', more = false): void {
    const key = `${ref}#${variant}`;
    const have = this.files.get(key);
    if (have && !more && have.status !== 'error') {
      if (have.status === 'ready' || this.state.phase !== 'open') return;
    }
    if (have?.status === 'loading' && this.state.phase === 'open' && [...this.fetches.values()].some((f) => f.key === key)) return;
    if (this.state.phase !== 'open' || !this.transport) {
      // Fetched as soon as the link opens; until then it's loading (or away, if the Mac sleeps).
      this.deferred.set(key, { ref, variant, more });
      if (!have) this.setFile(key, { status: this.state.phase === 'asleep' ? 'error' : 'loading', got: 0, error: this.state.phase === 'asleep' ? 'Your Mac is asleep' : undefined });
      return;
    }
    const off = more ? (have?.got ?? 0) : 0;
    const id = this.seq++;
    const fetch: Fetch = { key, ref, variant, parts: [], base: more ? (have?.text ?? '') : '', got: off, ...(variant === 'text' ? {} : { asm: new Assembly() }) };
    this.fetches.set(id, fetch);
    this.setFile(key, { ...(have ?? { got: 0 }), status: 'loading', error: undefined });
    this.ask(id, fetch, off);
  }

  /** Ask for a piece, and fail the fetch (with Retry on screen) if it doesn't come in time. */
  private ask(id: number, fetch: Fetch, off: number): void {
    if (fetch.timer) clearTimeout(fetch.timer);
    fetch.timer = setTimeout(() => {
      if (this.fetches.get(id) !== fetch) return;
      this.fetches.delete(id);
      this.endFetch(fetch);
      if (fetch.save) return this.failSave(fetch, 'Your Mac took too long to send it.');
      this.setFile(fetch.key, { status: 'error', got: 0, error: 'Your Mac took too long to send it.' });
    }, PIECE_TIMEOUT_MS);
    this.transport?.send({ t: 'get', id, ref: fetch.ref as OutputView['ref'], variant: fetch.variant, off });
  }

  private endFetch(fetch: Fetch, keep = false): void {
    if (fetch.timer) clearTimeout(fetch.timer);
    fetch.timer = undefined;
    if (!keep) fetch.sink?.drop();
  }

  private onChunk(f: MacFrame & { t: 'chunk' }): void {
    const fetch = this.fetches.get(f.id);
    if (!fetch) return;
    if (fetch.asm) return this.onPicturePiece(f.id, fetch, fetch.asm, f);
    fetch.parts.push(f.b64);
    if (!f.eof) return;
    this.fetches.delete(f.id);
    this.endFetch(fetch);
    const bytes = fromB64(fetch.parts.join(''));
    const text = fetch.base + fromUtf8(bytes);
    this.setFile(fetch.key, { status: 'ready', text, got: fetch.got + bytes.length, size: f.size, mime: f.mime });
  }

  /**
   * A piece of a picture (BLG-106): kept, then the next asked for until the last, so a Retina
   * screenshot or a big GIF comes whole (it used to stop at the first 192 KB, for ever).
   */
  private onPicturePiece(id: number, fetch: Fetch, asm: Assembly, f: MacFrame & { t: 'chunk' }): void {
    const step = asm.add(f);
    const fail = (error: string): void => {
      this.fetches.delete(id);
      this.endFetch(fetch);
      if (fetch.save) return this.failSave(fetch, error);
      this.setFile(fetch.key, { status: 'error', got: 0, error });
    };
    if (step.t === 'fail') return fail(step.error);
    // Full pictures go to a file as they come; thumbnails are small.
    fetch.sink ??= fetch.variant === 'full' ? fileSink(fetch.ref, f.mime, fetch.save ? 'save' : 'picture') : memorySink();
    fetch.sink.add(f.b64);
    if (step.t === 'next') {
      this.setFile(fetch.key, { status: 'loading', got: step.got, size: step.size, mime: f.mime });
      return this.ask(id, fetch, step.off);
    }
    this.fetches.delete(id);
    this.endFetch(fetch, true);
    try {
      const uri = fetch.sink.finish(f.mime);
      this.setFile(fetch.key, { status: 'ready', uri, got: step.got, size: step.size, mime: f.mime });
      fetch.save?.resolve(uri);
    } catch (e) {
      fail((e as Error).message);
    }
  }

  /**
   * The whole of an output in a file on the phone, to save it (BLG-123): a video or a file that
   * isn't on the phone yet, piece by piece like a full picture (bigger ones allowed: MAX_SAVE_BYTES).
   * How far it got is `file(ref, 'save')`; the copy is the caller's to delete.
   */
  saveCopy(ref: string): Promise<string> {
    const key = `${ref}#save`;
    if ([...this.fetches.values()].some((f) => f.key === key)) return Promise.reject(new Error('Already saving it.'));
    if (this.state.phase !== 'open' || !this.transport) return Promise.reject(new Error('Saving needs your Mac: it’s away.'));
    return new Promise<string>((resolve, reject) => {
      const id = this.seq++;
      const fetch: Fetch = { key, ref, variant: 'full', parts: [], base: '', got: 0, asm: new Assembly(MAX_SAVE_BYTES), save: { resolve, reject } };
      this.fetches.set(id, fetch);
      this.setFile(key, { status: 'loading', got: 0 });
      this.ask(id, fetch, 0);
    });
  }

  /** What `file(ref, 'save')` says goes, once the copy is saved (or it failed and was said). */
  doneSaving(ref: string): void {
    this.files.delete(`${ref}#save`);
    this.emit(`file:${ref}#save`);
  }

  /** The cache was emptied (Settings › Storage): full pictures are fetched again when next shown. */
  forgetPictures(): void {
    for (const [key, f] of [...this.files]) {
      if (!key.endsWith('#full') || f.status === 'loading') continue;
      this.files.delete(key);
      this.emit(`file:${key}`);
    }
  }

  private failSave(fetch: Fetch, error: string): void {
    this.setFile(fetch.key, { status: 'error', got: 0, error });
    fetch.save?.reject(new Error(error));
  }

  // ---- videos (BLG-100, BLG-103): streamed by the link worklet's loopback server

  /** A URL the video player streams this output from, or why it can't (the demo, the Mac away). */
  async mediaUrl(o: Pick<OutputView, 'ref' | 'name'>): Promise<string> {
    const t = this.transport;
    if (!t?.mediaBase) throw new Error('Videos play when the phone is linked to your Mac.');
    if (this.state.phase !== 'open') throw new Error('Your Mac is away.');
    return `${await t.mediaBase()}${mediaPath(o.ref, o.name)}`;
  }

  private setFile(key: string, s: FileState): void {
    this.files.set(key, s);
    this.emit(`file:${key}`);
  }

  // ---- a worktree's terminals (1.7): streamed only while their screen is open

  private termListeners = new Map<string, Set<(f: TermFrame) => void>>();
  private termsOn = new Map<string, number>();

  /**
   * Show a terminal: its output and status come to `fn` (from a clean screen first) until the
   * returned function is called. Attached again when the link opens or the app comes back.
   */
  attachTerm(key: string, fn: (f: TermFrame) => void): () => void {
    let set = this.termListeners.get(key);
    if (!set) this.termListeners.set(key, (set = new Set()));
    set.add(fn);
    this.termsOn.set(key, (this.termsOn.get(key) ?? 0) + 1);
    if (this.state.phase === 'open') this.transport?.send({ t: 'term_attach', term: key });
    return () => {
      set!.delete(fn);
      const n = (this.termsOn.get(key) ?? 1) - 1;
      if (n > 0) return void this.termsOn.set(key, n);
      this.termsOn.delete(key);
      if (this.state.phase === 'open') this.transport?.send({ t: 'term_detach', term: key });
    };
  }

  /** Keys typed on the phone, into the session the Mac shows too (dropped while the Mac is away). */
  termInput(key: string, data: string): boolean {
    if (this.state.phase !== 'open' || !this.transport || !data) return false;
    for (let at = 0; at < data.length; at += 64_000) this.transport.send({ t: 'term_input', term: key, data: data.slice(at, at + 64_000) });
    return true;
  }

  private reattachTerms(): void {
    for (const key of this.termsOn.keys()) this.transport?.send({ t: 'term_attach', term: key });
  }

  // ---- toasts

  toast(t: Omit<Toast, 'id'>): void {
    const toast = { ...t, id: this.seq++ };
    this.toasts = [...this.toasts.slice(-2), toast];
    this.emit('toasts');
    setTimeout(() => this.dismissToast(toast.id), 3600);
  }
  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit('toasts');
  }
  getToasts(): Toast[] {
    return this.toasts;
  }
}

export const store = new Store();
