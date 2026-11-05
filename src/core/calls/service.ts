import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Mesh } from '../../net/mesh/mesh.js';
import { dmConversation, groupConversation } from '../../net/mesh/views.js';
import { type CallPersonView, type CallView, type CallsView, GONE_MS, HEARTBEAT_MS, type MissedCallView, RING_MS, SIGNAL_MAX, keeps } from '../../shared/calls.js';

/**
 * Calls in your conversations with friends (BLG-706). The daemon doesn't carry any media: it rings,
 * keeps who's in each call, and passes WebRTC setup between the windows in it over the friends'
 * Noise links (`call` frames, checked here). Nobody runs the call: each Mac says it's there every
 * `HEARTBEAT_MS` to everyone in the conversation, and drops whoever went quiet for `GONE_MS`.
 *
 * Your side of a call belongs to one Mac screen, the one whose window makes your sound: the first
 * to say so (`set`) after you joined, from wherever you joined (the phone's Answer on your Mac
 * too). When that window goes quiet for `GONE_MS` (closed, crashed), you leave the call.
 */

const callId = z.string().regex(/^[0-9a-f]{16}$/);
const groupId = z.string().regex(/^[0-9a-f]{32}$/);
/** One person's words in a call: each phrase with when it was said. */
export const NotePhrases = z.array(z.object({ at: z.number().int().min(0), text: z.string().min(1).max(2_000) })).max(3_000);
export type NotePhrases = z.infer<typeof NotePhrases>;

const State = z.object({ muted: z.boolean(), sharing: z.boolean(), joinedAt: z.number().int().min(0), camera: z.boolean().optional(), uplink: z.number().int().min(0).max(10_000_000).optional() });

/** What one Mac says to another about a call (the `p` of a `call` link frame). `g`: the group; none for your DMs. */
export const CallFrame = z.discriminatedUnion('k', [
  z.object({ k: z.literal('ring'), call: callId, g: groupId.optional(), at: z.number().int().min(0), state: State }),
  z.object({ k: z.literal('here'), call: callId, g: groupId.optional(), startedBy: z.string().max(64), startedAt: z.number().int().min(0), state: State }),
  z.object({ k: z.literal('bye'), call: callId, g: groupId.optional() }),
  z.object({ k: z.literal('decline'), call: callId, g: groupId.optional() }),
  z.object({ k: z.literal('sig'), call: callId, g: groupId.optional(), d: z.string().max(SIGNAL_MAX) }),
  /** What someone said in a call, written down on their own Mac (BLG-715): sent to the others who were in it, as they leave. */
  z.object({ k: z.literal('notes'), call: callId, g: groupId.optional(), startedAt: z.number().int().min(0), phrases: NotePhrases }),
]);
export type CallFrame = z.infer<typeof CallFrame>;

type PersonState = z.infer<typeof State>;

interface Person extends PersonState {
  seen: number;
}

interface Mine extends PersonState {
  /** The screen whose window makes your side of the call (undefined until one says so). */
  screen?: string;
  /** When that screen last said so. */
  kept: number;
}

interface Call {
  readonly id: string;
  readonly conversation: string;
  readonly startedBy: string;
  readonly startedAt: number;
  readonly people: Map<string, Person>;
  me?: Mine;
  ringing?: { readonly by: string; readonly since: number };
  /** Someone else was in it while you were: once they've all gone, so has the call. */
  met?: boolean;
}

/** Call frames one person may send a second (setup is a burst of candidates; more is a flood). */
const FRAMES_PER_SECOND = 60;
/** How far ahead of this Mac's clock a "joined at" may say (clocks differ a little, not by days). */
const CLOCK_SLACK_MS = 60_000;

/**
 * Whom a call's frames go to and come from: your friends' Noise links (`meshLinks`) or a room's
 * hub (core/calls/room.ts). Conversation ids are the transport's own (`dm:…`, `group:…`, `room`).
 */
export interface CallLinks {
  /** You, as the others know you here. */
  readonly peerId: string;
  conversations(): string[];
  shares(conversation: string, peerId: string): boolean;
  peopleIn(conversation: string): string[];
  nameFor(peerId: string): string;
  sendCall(peerId: string, payload: unknown): boolean;
  /** The conversation a frame from `from` is about (`g`: the group it names, if any). */
  conversationOf(from: string, g?: string): string;
  /** The group id a conversation's frames name (none for a DM or a room). */
  groupOf(conversation: string): string | undefined;
  onCall(fn: (from: string, payload: unknown) => void): () => void;
  /** People or conversations changed (someone left a group, the room). */
  onChange(fn: () => void): () => void;
}

/** Calls over your friends' links (DMs and channels). */
export function meshLinks(mesh: Mesh): CallLinks {
  return {
    get peerId() {
      return mesh.peerId;
    },
    conversations: () => mesh.conversations(),
    shares: (c, p) => mesh.shares(c, p),
    peopleIn: (c) => mesh.peopleIn(c),
    nameFor: (p) => mesh.nameFor(p),
    sendCall: (p, payload) => mesh.sendCall(p, payload),
    conversationOf: (from, g) => (g ? groupConversation(g) : dmConversation(from)),
    groupOf: (c) => (c.startsWith('group:') ? c.slice(6) : undefined),
    onCall: (fn) => {
      mesh.on('call', fn);
      return () => void mesh.off('call', fn);
    },
    onChange: (fn) => {
      mesh.on('change', fn);
      return () => void mesh.off('change', fn);
    },
  };
}

export interface CallHost {
  readonly links: CallLinks;
  /** The calls changed: what screens see now. */
  readonly publish: (calls: CallsView) => void;
  /** WebRTC setup for the window in a call (to its screen; undefined: every screen). */
  readonly signal: (to: string | undefined, s: { readonly conversation: string; readonly call: string; readonly from: string; readonly data: string }) => void;
  /** Someone rings you (a notification, the phone's Needs you), or it stopped ringing. */
  readonly ring: (call: CallView, on: boolean) => void;
  /** Something to say on the screen ("Bob didn't answer"). */
  readonly toast: (text: string) => void;
  /** The screen making this request (core/client-context). */
  readonly client: () => string | undefined;
  readonly now?: () => number;
  /** Timers off (tests drive `tick` themselves). */
  readonly manual?: boolean;
  /** No window makes this Mac's side of a call (the demo's friends): it never goes quiet. */
  readonly headless?: boolean;
  /** Someone's notes of a call you were in (core/calls/notes.ts keeps them). */
  readonly notes?: (from: string, call: PastCall, phrases: NotePhrases) => void;
  /** A call rang for you and stopped before you answered or declined it (core/calls/missed.ts keeps it). */
  readonly missed?: (call: MissedCallView) => void;
}

/** A call you were in: who else was, at any point (kept a while after it ends, for its notes). */
export interface PastCall {
  readonly id: string;
  readonly conversation: string;
  readonly startedAt: number;
  readonly people: ReadonlySet<string>;
  readonly lastSeen: number;
}

/** How long a call you were in is remembered after it ends (its notes may still come). */
const PAST_MS = 12 * 60 * 60_000;

export class CallService {
  private readonly calls = new Map<string, Call>();
  private readonly timer: NodeJS.Timeout | undefined;
  private readonly offs: Array<() => void> = [];
  private readonly frames = new Map<string, { second: number; count: number }>();
  private readonly past = new Map<string, PastCall>();

  constructor(private readonly host: CallHost) {
    const onCall = (from: string, p: unknown): void => this.receive(from, p);
    const onChange = (): void => this.prune();
    this.offs.push(host.links.onCall(onCall), host.links.onChange(onChange));
    if (!host.manual) {
      this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
      this.timer.unref();
    }
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  stop(): void {
    for (const c of this.calls.values()) if (c.me) this.broadcast(c, { k: 'bye', call: c.id });
    this.calls.clear();
    clearInterval(this.timer);
    for (const off of this.offs) off();
    this.publish();
  }

  // ---- what screens ask

  /** Call everyone in a conversation (or join the call it has). Nobody it can reach now: no call. */
  start(conversation: string): CallView {
    this.needConversation(conversation);
    const existing = this.calls.get(conversation);
    if (existing && (existing.people.size || existing.me)) return this.join(conversation);
    const now = this.now();
    const call: Call = { id: randomBytes(8).toString('hex'), conversation, startedBy: this.host.links.peerId, startedAt: now, people: new Map() };
    call.me = { muted: false, sharing: false, joinedAt: now, kept: now, ...this.screenNow() };
    if (!this.broadcast(call, { k: 'ring', call: call.id, at: now, state: this.mineState(call) })) throw new Error(this.unreachable(conversation));
    this.calls.set(conversation, call);
    this.publish();
    return this.view(call);
  }

  /** Join the call in a conversation (answering it, or one going on that you weren't in). */
  join(conversation: string): CallView {
    const call = this.need(conversation);
    if (!call.me) {
      const now = this.now();
      call.me = { muted: false, sharing: false, joinedAt: now, kept: now, ...this.screenNow() };
    } else this.claim(call.me);
    const wasRinging = call.ringing;
    call.ringing = undefined;
    if (wasRinging) this.host.ring(this.view(call), false);
    this.sayHere(call);
    this.publish();
    return this.view(call);
  }

  leave(conversation: string): void {
    const call = this.calls.get(conversation);
    if (!call?.me) return;
    call.me = undefined;
    this.broadcast(call, { k: 'bye', call: call.id });
    if (!call.people.size) this.calls.delete(conversation);
    this.publish();
  }

  /** Not now: it stops ringing here, and the one who rang hears you declined. */
  decline(conversation: string): void {
    const call = this.calls.get(conversation);
    if (!call?.ringing) return;
    const by = call.ringing.by;
    call.ringing = undefined;
    this.host.ring(this.view(call), false);
    this.send(by, call, { k: 'decline', call: call.id });
    this.publish();
  }

  /**
   * Mute, share, or say your window is still making the call (it does every few seconds): the
   * screen saying so becomes the one the call's setup goes to.
   */
  set(conversation: string, change: { readonly muted?: boolean; readonly sharing?: boolean; readonly camera?: boolean; readonly uplink?: number }): CallView {
    const call = this.need(conversation);
    if (!call.me) throw new Error('You’re not in this call');
    const before = { muted: call.me.muted, sharing: call.me.sharing, camera: Boolean(call.me.camera), uplink: call.me.uplink };
    if (change.muted !== undefined) call.me.muted = change.muted;
    if (change.sharing !== undefined) call.me.sharing = change.sharing;
    if (change.camera !== undefined) call.me.camera = change.camera;
    if (change.uplink !== undefined) call.me.uplink = change.uplink;
    this.claim(call.me);
    if (before.muted !== call.me.muted || before.sharing !== call.me.sharing || before.camera !== Boolean(call.me.camera) || before.uplink !== call.me.uplink) {
      this.sayHere(call);
      this.publish();
    }
    return this.view(call);
  }

  /** WebRTC setup from your window to theirs (an offer, an answer, a candidate: opaque here). */
  signal(conversation: string, to: string, data: string): boolean {
    const call = this.need(conversation);
    if (!call.me || !call.people.has(to)) return false;
    return this.send(to, call, { k: 'sig', call: call.id, d: data });
  }

  list(): CallsView {
    return Object.fromEntries([...this.calls.values()].map((c) => [c.conversation, this.view(c)]));
  }

  // ---- what other Macs say

  receive(from: string, raw: unknown): void {
    const parsed = CallFrame.safeParse(raw);
    if (!parsed.success) return;
    const now = this.now();
    if (parsed.data.k === 'notes') return this.receiveNotes(from, parsed.data);
    if (this.flooding(from, now)) return;
    const f = parsed.data.k === 'ring' || parsed.data.k === 'here' ? { ...parsed.data, state: { ...parsed.data.state, joinedAt: Math.min(parsed.data.state.joinedAt, now + CLOCK_SLACK_MS) } } : parsed.data;
    const conversation = this.host.links.conversationOf(from, f.g);
    if (!this.host.links.shares(conversation, from)) return;
    let call = this.calls.get(conversation);
    if (call && call.id !== f.call) {
      if (f.k !== 'ring' && f.k !== 'here') return;
      // Two calls in one conversation (two people pressed Call at once): everyone keeps the same one.
      if (keeps(call.id, f.call) === call.id) {
        if (call.me) this.send(from, call, { k: 'here', call: call.id, startedBy: call.startedBy, startedAt: call.startedAt, state: this.mineState(call) });
        return;
      }
      // Only a call just starting gives way: one people are talking in isn't taken over by a newcomer's.
      if (call.met && now - call.startedAt > RING_MS) return;
      const wasIn = call.me;
      if (call.ringing) this.host.ring(this.view(call), false);
      this.calls.delete(conversation);
      call = undefined;
      if (wasIn) {
        call = this.fresh(conversation, f, from, now);
        call.me = { ...wasIn, joinedAt: now };
        this.calls.set(conversation, call);
        this.sayHere(call);
      }
    }
    switch (f.k) {
      case 'ring':
      case 'here': {
        if (!call) {
          call = this.fresh(conversation, f, from, now);
          this.calls.set(conversation, call);
          // A ring, or the first `here` of a call whose ring didn't reach this Mac (they're alone in it).
          if (!call.me && (f.k === 'ring' || f.startedBy === from)) {
            call.ringing = { by: from, since: now };
            this.host.ring(this.view(call), true);
          }
        }
        const isNew = !call.people.has(from);
        call.people.set(from, { ...f.state, seen: now });
        if (call.me) call.met = true;
        // Someone new: they hear you're here at once (their window starts setting up with yours).
        if (isNew && call.me) this.send(from, call, { k: 'here', call: call.id, startedBy: call.startedBy, startedAt: call.startedAt, state: this.mineState(call) });
        break;
      }
      case 'bye':
        if (!call) return;
        call.people.delete(from);
        if (this.lastOneOut(call)) return;
        this.endIfEmpty(call);
        break;
      case 'decline':
        if (!call?.me) return;
        // In a direct conversation that's the only other person: the call is over.
        if (conversation.startsWith('dm:') && !call.people.size) {
          this.host.toast(`${this.host.links.nameFor(from)} can’t talk right now`);
          this.leave(conversation);
          return;
        }
        return;
      case 'sig':
        if (!call?.me || !call.people.has(from)) return;
        call.people.get(from)!.seen = now;
        this.host.signal(call.me.screen, { conversation, call: call.id, from, data: f.d });
        return;
    }
    this.publish();
  }

  /** Every `HEARTBEAT_MS`: say you're still here, drop who went quiet, stop ringing nobody answered. */
  tick(): void {
    const now = this.now();
    let changed = false;
    for (const call of [...this.calls.values()]) {
      for (const [peerId, p] of call.people) {
        if (now - p.seen > GONE_MS) {
          call.people.delete(peerId);
          changed = true;
        }
      }
      if (call.me && call.met && !call.people.size) {
        changed = this.lastOneOut(call) || changed;
        continue;
      }
      if (call.me && !call.met && !call.people.size && call.startedBy === this.host.links.peerId && now - call.startedAt > RING_MS) {
        this.host.toast(call.conversation.startsWith('dm:') ? `${this.host.links.nameFor(call.conversation.slice(3))} didn’t answer` : 'Nobody picked up');
        call.me = undefined;
        this.broadcast(call, { k: 'bye', call: call.id });
        changed = true;
      }
      if (call.me && !this.host.headless && now - call.me.kept > GONE_MS) {
        // The window making your side of it went away: you're out of the call.
        call.me = undefined;
        this.broadcast(call, { k: 'bye', call: call.id });
        changed = true;
      }
      if (call.ringing && now - call.ringing.since > RING_MS) {
        this.missedRing(call);
        changed = true;
      }
      if (call.me) this.sayHere(call);
      if (this.endIfEmpty(call)) changed = true;
    }
    if (changed) this.publish();
  }

  /** You, as the others in these calls know you. */
  get selfId(): string {
    return this.host.links.peerId;
  }

  /** A call you were in (now or within the last hours), with everyone who was in it too. */
  pastCall(id: string): PastCall | undefined {
    return this.past.get(id);
  }

  /** Your notes of a call you were in go to everyone else who was (they're linked now, or they miss them). */
  sendNotes(id: string, phrases: NotePhrases): number {
    const call = this.past.get(id);
    if (!call) throw new Error('That call isn’t one you were in');
    const g = this.host.links.groupOf(call.conversation);
    let sent = 0;
    for (const peerId of call.people) {
      if (peerId === this.host.links.peerId || !this.host.links.shares(call.conversation, peerId)) continue;
      if (this.host.links.sendCall(peerId, { k: 'notes', call: id, startedAt: call.startedAt, phrases, ...(g ? { g } : {}) })) sent++;
    }
    return sent;
  }

  private receiveNotes(from: string, f: Extract<CallFrame, { k: 'notes' }>): void {
    const call = this.past.get(f.call);
    const conversation = this.host.links.conversationOf(from, f.g);
    // Only from someone who was in a call you were in, in the conversation it was in.
    if (!call || call.conversation !== conversation || !call.people.has(from) || !this.host.links.shares(conversation, from)) return;
    this.host.notes?.(from, call, f.phrases);
  }

  // ---- inside

  /** Remember who's been in the calls you're in (for their notes), and forget old ones. */
  private remember(now: number): void {
    for (const call of this.calls.values()) {
      if (!call.me) continue;
      const was = this.past.get(call.id);
      const people = new Set([...(was?.people ?? []), this.host.links.peerId, ...call.people.keys()]);
      this.past.set(call.id, { id: call.id, conversation: call.conversation, startedAt: call.startedAt, people, lastSeen: now });
    }
    for (const [id, c] of this.past) if (now - c.lastSeen > PAST_MS) this.past.delete(id);
  }

  /** Everyone else left: so do you, and the call is over. */
  private lastOneOut(call: Call): boolean {
    if (!call.me || !call.met || call.people.size) return false;
    call.me = undefined;
    this.broadcast(call, { k: 'bye', call: call.id });
    this.calls.delete(call.conversation);
    this.host.toast('The call ended');
    this.publish();
    return true;
  }

  /** More call frames from one person than any call needs: the rest of this second is dropped. */
  private flooding(from: string, now: number): boolean {
    const second = Math.floor(now / 1000);
    const was = this.frames.get(from);
    const count = was?.second === second ? was.count + 1 : 1;
    this.frames.set(from, { second, count });
    if (this.frames.size > 500) this.frames.clear();
    return count > FRAMES_PER_SECOND;
  }

  private fresh(conversation: string, f: Extract<CallFrame, { k: 'ring' | 'here' }>, from: string, now: number): Call {
    return { id: f.call, conversation, startedBy: f.k === 'ring' ? from : f.startedBy, startedAt: f.k === 'ring' ? f.at : f.startedAt, people: new Map([[from, { ...f.state, seen: now }]]) };
  }

  /** A call with nobody left in it (you not either) is over: still ringing for you, you missed it. */
  private endIfEmpty(call: Call): boolean {
    if (call.people.size || call.me) return false;
    if (call.ringing) this.missedRing(call);
    this.calls.delete(call.conversation);
    return true;
  }

  /** It stops ringing without you answering or saying not now: "Ann tried calling you". */
  private missedRing(call: Call): void {
    const ring = call.ringing;
    if (!ring) return;
    call.ringing = undefined;
    this.host.ring(this.view(call), false);
    this.host.missed?.({ id: call.id, conversation: call.conversation, by: ring.by, name: this.host.links.nameFor(ring.by), at: ring.since });
  }

  /** Why a call can't start: nobody it would ring is linked now. */
  private unreachable(conversation: string): string {
    const people = this.host.links.peopleIn(conversation);
    if (conversation.startsWith('dm:') && people.length === 1) return `${this.host.links.nameFor(people[0]!)} can’t be reached right now`;
    return people.length ? 'Nobody here can be reached right now' : 'There’s nobody here to call';
  }

  /** People who left a conversation (or a friend you removed) are out of its call. */
  private prune(): void {
    let changed = false;
    for (const call of [...this.calls.values()]) {
      if (!this.host.links.conversations().includes(call.conversation)) {
        this.calls.delete(call.conversation);
        changed = true;
        continue;
      }
      for (const peerId of [...call.people.keys()]) {
        if (!this.host.links.shares(call.conversation, peerId)) {
          call.people.delete(peerId);
          changed = true;
        }
      }
      if (this.endIfEmpty(call)) changed = true;
    }
    if (changed) this.publish();
  }

  private screenNow(): { screen?: string } {
    const c = this.host.client();
    return c && !c.startsWith('phone:') ? { screen: c } : {};
  }

  /** A Mac screen speaking for your side of the call takes it over (the phone never does). */
  private claim(me: Mine): void {
    const c = this.host.client();
    if (!c || c.startsWith('phone:')) return;
    me.screen = c;
    me.kept = this.now();
  }

  private mineState(call: Call): PersonState {
    const me = call.me!;
    return { muted: me.muted, sharing: me.sharing, joinedAt: me.joinedAt, ...(me.camera ? { camera: true } : {}), ...(me.uplink !== undefined ? { uplink: me.uplink } : {}) };
  }

  private sayHere(call: Call): void {
    if (!call.me) return;
    this.broadcast(call, { k: 'here', call: call.id, startedBy: call.startedBy, startedAt: call.startedAt, state: this.mineState(call) });
  }

  /** → how many it reached. */
  private broadcast(call: Call, frame: CallFrame): number {
    let reached = 0;
    for (const peerId of this.host.links.peopleIn(call.conversation)) if (this.send(peerId, call, frame)) reached++;
    return reached;
  }

  private send(peerId: string, call: Call, frame: CallFrame): boolean {
    const g = this.host.links.groupOf(call.conversation);
    return this.host.links.sendCall(peerId, { ...frame, ...(g ? { g } : {}) });
  }

  private needConversation(conversation: string): void {
    if (!this.host.links.conversations().includes(conversation)) throw new Error('No such conversation');
  }

  private need(conversation: string): Call {
    const call = this.calls.get(conversation);
    if (!call) throw new Error('There’s no call here now');
    return call;
  }

  private view(call: Call): CallView {
    const mesh = this.host.links;
    const people: CallPersonView[] = [...call.people].map(([peerId, p]) => ({ peerId, name: mesh.nameFor(peerId), muted: p.muted, sharing: p.sharing, joinedAt: p.joinedAt, ...(p.camera ? { camera: true } : {}), ...(p.uplink !== undefined ? { uplink: p.uplink } : {}) }));
    if (call.me) people.push({ peerId: mesh.peerId, name: 'You', me: true, muted: call.me.muted, sharing: call.me.sharing, joinedAt: call.me.joinedAt, ...(call.me.camera ? { camera: true } : {}), ...(call.me.uplink !== undefined ? { uplink: call.me.uplink } : {}) });
    people.sort((a, b) => a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1));
    return {
      id: call.id,
      conversation: call.conversation,
      startedBy: call.startedBy,
      startedAt: call.startedAt,
      people,
      mine: call.me ? 'in' : call.ringing ? 'ringing' : 'out',
      ...(call.ringing ? { ringBy: call.ringing.by, ringSince: call.ringing.since } : {}),
    };
  }

  private publish(): void {
    this.remember(this.now());
    this.host.publish(this.list());
  }
}
