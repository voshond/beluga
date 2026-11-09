import type { CallOutcome } from '../daemon/dispatch.js';
import type { Intent, IntentBus } from '../core/intents.js';
import type { Action, Approval, DomainState, Store } from '../core/store.js';
import { type DaemonFrame, IPC_VERSION, encodeFrame, parseDaemonFrame } from '../ipc/protocol.js';
import { readJson, writeJson } from '../net/mesh/files.js';
import type { NetworkState } from '../net/mesh/views.js';
import type { MessageSocket } from '../net/transport.js';
import type { MachineRecord } from './book.js';
import { LINK_TOKEN } from './door.js';

/**
 * Friends through your Always On (BLG-797). While another computer of yours is you on the network,
 * this install's daemon keeps a client link of its own to it (the app protocol, as a screen of yours
 * on that computer, end-to-end encrypted) and:
 *  - mirrors its friends network into this install's state (`net_mirror`, then each `net_*` action
 *    as it happens), so People, DMs, groups, rooms, calls and the phone's views work as before, and
 *    their notifications come as they always did (they're worked out from the state);
 *  - says what this Mac's screens show (attention), so the Always On marks those read, and Seen;
 *  - mirrors friends' requests waiting for your answer (approvals with a `peer`) as `ao:<id>`, so
 *    this Mac and the phone show them; the first answer from any device is the one that counts;
 *  - forwards `network.*` and `calls.*` calls there (Settings' Friends switch turns it on and off there), and hands call signals back to the screen in the
 *    call (audio and video stay on the device you use; only signalling goes through it).
 * What it last mirrored is kept (friends-mirror.json), so a message that came while this Mac was
 * closed is news on opening (worked out against it) and the network still shows while it's offline.
 */

const BACKOFF_MS = [500, 2_000, 5_000, 15_000, 30_000, 60_000] as const;
const CALL_MS = 30_000;
const CHECK_MS = 5_000;
const SAVE_MS = 2_000;
const OWN = 'fl:';
export const MIRRORED = 'ao:';

/** Every friends network call, turning it on and off included: it runs there. */
export const forwardsToAlwaysOn = (method: string): boolean => method.startsWith('network.') || method.startsWith('calls.');

/** Intents from your Always On that belong to a screen here. */
const PASSED_INTENTS = new Set<Intent['type']>(['call_signal', 'toast']);

export interface FriendsLinkOptions {
  readonly machines: { book: { get(id: string): MachineRecord | undefined }; drives(r: MachineRecord): boolean; openLink(r: MachineRecord): Promise<MessageSocket> };
  /** Your Always On's id, when it isn't this install. */
  readonly at: () => string | undefined;
  readonly store: Pick<Store, 'getState' | 'dispatch' | 'subscribe'>;
  readonly intents: Pick<IntentBus, 'emit'>;
  readonly version: string;
  /** Where what was last mirrored is kept (~/.beluga/friends-mirror.json). */
  readonly file?: string;
  readonly backoffMs?: readonly number[];
  readonly checkMs?: number;
  readonly callMs?: number;
  readonly log?: (line: string) => void;
}

const isNetAction = (a: Action): boolean => a.type.startsWith('net_') && a.type !== 'net_off' && a.type !== 'net_mirror';
const asks = (a: Approval): boolean => a.peer !== undefined;

export class FriendsLink {
  private socket?: MessageSocket;
  private welcomed = false;
  private target?: string;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private checker?: NodeJS.Timeout;
  private saver?: NodeJS.Timeout;
  private offStore?: () => void;
  private sentAttention?: DomainState['attention'];
  private stopped = false;
  private seq = 0;
  private readonly own = new Map<string, { resolve: (v: CallOutcome) => void; timer: NodeJS.Timeout }>();
  /** Approvals mirrored from your Always On, by their id there. */
  private readonly mirrored = new Set<string>();
  /** Which screen here is in each call, for its signals. */
  private readonly inCall = new Map<string, string>();

  constructor(private readonly opts: FriendsLinkOptions) {}

  start(): void {
    this.offStore = this.opts.store.subscribe(() => this.attention());
    this.check();
    this.checker = setInterval(() => this.check(), this.opts.checkMs ?? CHECK_MS);
    this.checker.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.offStore?.();
    clearInterval(this.checker);
    this.save();
    this.drop('Beluga is shutting down');
  }

  /** Your Always On is another computer: this install's network calls go there. */
  get routing(): boolean {
    return this.target !== undefined;
  }

  /** Your Always On is reachable through this link now. */
  get live(): boolean {
    return Boolean(this.socket?.isOpen && this.welcomed);
  }

  /** The Always On may have moved (always-on.ts says so): follow it. */
  check(): void {
    if (this.stopped) return;
    const at = this.opts.at();
    if (at === this.target) {
      if (at && !this.socket && !this.timer) this.connect();
      return;
    }
    this.drop('Your Always On moved');
    this.unmirrorApprovals();
    this.target = at;
    this.attempt = 0;
    if (!at) return;
    // What it said last, at once: shown while the link comes up, and what's new is worked out against it.
    const kept = this.opts.file ? (readJson(this.opts.file) as { at?: string; network?: NetworkState } | undefined) : undefined;
    if (kept?.at === at && kept.network && typeof kept.network === 'object') this.opts.store.dispatch({ type: 'net_mirror', network: kept.network });
    this.connect();
  }

  /** One call there, as `client` here made it. */
  call(method: string, args: readonly unknown[], client?: string): Promise<CallOutcome> {
    const socket = this.socket;
    const name = this.name();
    if (!socket?.isOpen || !this.welcomed) return Promise.resolve({ ok: false, error: `${name}, your Always On, can’t be reached right now; Beluga keeps trying` });
    if (client && (method === 'calls.start' || method === 'calls.join') && typeof args[0] === 'string') this.inCall.set(args[0], client);
    if (method === 'calls.leave' && typeof args[0] === 'string') this.inCall.delete(args[0]);
    const id = `${OWN}${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.own.delete(id);
        resolve({ ok: false, error: `${name} didn’t answer in time` });
      }, this.opts.callMs ?? CALL_MS);
      timer.unref?.();
      this.own.set(id, { resolve, timer });
      socket.send(encodeFrame({ t: 'call', id, method, args: [...args] }));
    });
  }

  private name(): string {
    return (this.target && this.opts.machines.book.get(this.target)?.name) || 'Your Always On';
  }

  private connect(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const id = this.target;
    const record = id ? this.opts.machines.book.get(id) : undefined;
    if (this.stopped || !record || !this.opts.machines.drives(record)) return;
    this.opts.machines.openLink(record).then(
      (socket) => {
        if (this.stopped || this.target !== id) return socket.close(1000);
        this.socket = socket;
        this.welcomed = false;
        socket.on('message', (text: string) => this.fromAlwaysOn(text));
        socket.once('close', () => this.dropped(socket));
        socket.send(encodeFrame({ t: 'hello', token: LINK_TOKEN, ipc: IPC_VERSION, kind: 'mac', version: this.opts.version, caps: [] }));
      },
      (err: unknown) => {
        this.opts.log?.(`friends: couldn't reach ${record.name}: ${err instanceof Error ? err.message : String(err)}`);
        this.retry();
      },
    );
  }

  private fromAlwaysOn(text: string): void {
    let frame: DaemonFrame;
    try {
      frame = parseDaemonFrame(text);
    } catch {
      return;
    }
    switch (frame.t) {
      case 'welcome':
        this.welcomed = true;
        this.attempt = 0;
        this.sentAttention = undefined;
        this.mirror(frame.snapshot);
        this.attention();
        return;
      case 'snapshot':
        return this.mirror(frame.snapshot);
      case 'action':
        return this.take(frame.action);
      case 'result': {
        const own = this.own.get(frame.id);
        if (!own) return;
        this.own.delete(frame.id);
        clearTimeout(own.timer);
        return own.resolve(frame.ok ? { ok: true, ...(frame.value === undefined ? {} : { value: frame.value }) } : { ok: false, error: frame.error ?? 'It failed' });
      }
      case 'intent': {
        if (!PASSED_INTENTS.has(frame.intent.type)) return;
        const to = frame.intent.type === 'call_signal' ? this.inCall.get(frame.intent.conversation) : undefined;
        return this.opts.intents.emit(frame.intent, to);
      }
      case 'cap_call':
        // This link offers nothing of this Mac's to your Always On.
        return this.socket?.send(encodeFrame({ t: 'cap_result', id: frame.id, ok: false, error: 'Not over this link' }));
      case 'bye':
        this.opts.log?.(`friends: ${this.name()} said ${frame.reason}`);
        return;
      default:
        return;
    }
  }

  /** Your Always On's state as it is now: its network whole, and the friends' requests waiting on you. */
  private mirror(snapshot: DomainState): void {
    this.opts.store.dispatch({ type: 'net_mirror', network: snapshot.network });
    const waiting = snapshot.approvals.filter(asks);
    for (const id of [...this.mirrored]) if (!waiting.some((a) => a.id === id)) this.unmirror(id);
    for (const a of waiting) if (!this.mirrored.has(a.id)) this.mirrorApproval(a);
    this.later();
  }

  private take(action: Action): void {
    if (isNetAction(action)) {
      this.opts.store.dispatch(action);
      return this.later();
    }
    if (action.type === 'approval_add' && asks(action.approval)) return this.mirrorApproval(action.approval);
    if (action.type === 'approval_remove' && this.mirrored.has(action.id)) return this.unmirror(action.id);
  }

  private mirrorApproval(a: Approval): void {
    this.mirrored.add(a.id);
    this.opts.store.dispatch({ type: 'approval_add', approval: { ...a, id: `${MIRRORED}${a.id}` } });
  }

  private unmirror(id: string): void {
    this.mirrored.delete(id);
    this.opts.store.dispatch({ type: 'approval_remove', id: `${MIRRORED}${id}` });
  }

  /** They can't be answered while the link is down, or once your Always On moved. */
  private unmirrorApprovals(): void {
    for (const id of [...this.mirrored]) this.unmirror(id);
  }

  /** What this Mac's screens show, said there (it marks those conversations read, and Seen). */
  private attention(): void {
    const attention = this.opts.store.getState().attention;
    if (!this.live || attention === this.sentAttention) return;
    this.sentAttention = attention;
    const cap = (list: readonly string[]): string[] => list.filter((c) => c.length <= 200).slice(0, 50);
    this.socket?.send(encodeFrame({ t: 'attention', attention: { shown: cap(attention.shown), visible: cap(attention.visible), files: attention.files, front: attention.front } }));
  }

  /** Keep what was mirrored (throttled). */
  private later(): void {
    if (!this.opts.file || this.saver) return;
    this.saver = setTimeout(() => {
      this.saver = undefined;
      this.save();
    }, SAVE_MS);
    this.saver.unref?.();
  }

  private save(): void {
    clearTimeout(this.saver);
    this.saver = undefined;
    const network = this.opts.store.getState().network;
    if (this.opts.file && this.target && network.enabled) writeJson(this.opts.file, { at: this.target, network });
  }

  private dropped(socket: MessageSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.welcomed = false;
    for (const [id, own] of this.own) {
      clearTimeout(own.timer);
      own.resolve({ ok: false, error: `The link to ${this.name()} dropped before it answered; try again` });
      this.own.delete(id);
    }
    this.unmirrorApprovals();
    this.retry();
  }

  private retry(): void {
    if (this.stopped || !this.target) return;
    const wait = this.opts.backoffMs ?? BACKOFF_MS;
    const ms = wait[Math.min(this.attempt, wait.length - 1)]!;
    this.attempt += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), ms);
    this.timer.unref?.();
  }

  private drop(reason: string): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.welcomed = false;
    socket?.close(1000, reason);
  }
}

// ---- the daemon's calls (daemon/dispatch.ts)

const links = new WeakMap<object, FriendsLink>();
export const attachFriendsLink = (session: object, link: FriendsLink): void => void links.set(session, link);
export const detachFriendsLink = (session: object): void => void links.delete(session);

/**
 * A call that goes to your Always On instead of running here: a `network.*` or `calls.*` call while
 * it's you on the network, or the answer to a friend's request mirrored from it.
 */
export function routeToAlwaysOn(session: object & { store: { getState(): DomainState } }, method: string, args: readonly unknown[], client: string): Promise<CallOutcome> | undefined {
  const link = links.get(session);
  if (!link) return undefined;
  if (method === 'host.answerApproval') {
    const id = (args[1] ?? session.store.getState().approvals[0]?.id) as unknown;
    return typeof id === 'string' && id.startsWith(MIRRORED) ? link.call(method, [args[0], id.slice(MIRRORED.length)], client) : undefined;
  }
  if (!forwardsToAlwaysOn(method)) return undefined;
  // Here only while your Always On is another computer; otherwise this install runs the network itself.
  return link.routing ? link.call(method, args, client) : undefined;
}
