import { useSyncExternalStore } from 'react';
import { kv } from './kv';
import type { Call } from './link/calls';
import type { ChatView, ConvView, Topic } from './link/protocol';
import { store } from './store';

/**
 * What you send from the phone shows at once, and counts as sent only when your Mac says so.
 *
 * A message in a conversation or chat is drawn right away as yours, "Sending…". The Mac's answer
 * to the call confirms it (or refuses it: it stays, "Not sent", with Retry and Remove, your words
 * kept). The bubble goes only when the Mac's own view has the message, so it never blinks out
 * before the real one is there. If the link drops before the Mac answers, nobody knows yet: it
 * says "Checking…" until the Mac's next view shows it there (gone) or not (Not sent).
 *
 * A start from Ask (a new worktree, a plan, a question in a project, a friend's Claude) opens its
 * Starting screen at once (app/starting/[id].tsx), which becomes the conversation or the plan when
 * the Mac answers, and goes back to Ask with your words if it says no.
 *
 * While your Mac is away, sends wait here (kept across launches) and go when it welcomes the phone.
 */

export type SendState = 'sending' | 'waiting' | 'sent' | 'unsure' | 'failed';
export type StartKind = 'worktree' | 'plan' | 'question' | 'friend';

export interface Start {
  readonly kind: StartKind;
  /** Where it was sent, as Ask names it (its pill): "Beluga", "Mia's Claude". */
  readonly label: string;
  readonly project?: string;
  readonly icon?: string;
  /** Ask's target key, to aim Ask at it again if it has to go back. */
  readonly target: string;
  readonly plan?: boolean;
}

export interface Send {
  readonly id: string;
  /** Where it shows: a conversation or chat topic, or `new:<id>` (a start's own screen). */
  readonly where: string;
  readonly text: string;
  readonly at: number;
  readonly state: SendState;
  readonly error?: string;
  readonly call?: Call;
  /** Your messages already in the view when it was sent: the new one is the one not among them. */
  readonly seen: readonly string[];
  readonly start?: Start;
  /** A start the Mac took: the conversation it opened, or the plan. */
  readonly topic?: Topic;
  readonly plan?: string;
  /** It carries a photo (sent first, `put`): not kept across launches. */
  readonly photo?: boolean;
  /** Made on one of your computers, over its own link (BLG-810); none: your Mac. */
  readonly on?: string;
}

/** How long a confirmed bubble may wait for the view to show it before it goes anyway. */
const SHOWN_WITHIN_MS = 12_000;
/** A start the Mac took stays this long for its screen to pick up. */
const START_KEPT_MS = 60_000;

type Prepare = () => Promise<Call>;

class Sends {
  private list: Send[] = [];
  private prepares = new Map<string, Prepare>();
  private listeners = new Set<() => void>();
  private snaps = new Map<string, readonly Send[]>();
  private watched = new Set<string>();
  private seq = 1;
  /** What a failed start leaves for Ask (its words, and where they were going). */
  draft: { text: string; target: string; how?: string } | undefined;
  /** Starts whose screen is open: they go back to Ask themselves on a refusal. */
  private shown = new Set<string>();

  constructor() {
    // Mid-flight when the phone last closed: a message is checked against the Mac's view; a start can't be.
    this.list = (kv.get<Send[]>('sends') ?? []).map((s) =>
      s.state !== 'sending' ? s : s.start ? { ...s, state: 'failed', error: 'The app closed before your Mac answered. Check Work before trying again.' } : { ...s, state: 'unsure' },
    );
    for (const s of this.list) this.watchTopic(s.where);
    store.subscribe('linked', () => this.onLinked());
    // Your Always On linked (BLG-850): a chat message waiting for your Mac can go there.
    store.subscribe('computers', () => {
      if (store.friendsOn()) for (const s of this.list) if (s.state === 'waiting' && s.where.startsWith('chat:')) this.run(s.id);
    });
  }

  // ---- for screens

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  of(where: string): readonly Send[] {
    let s = this.snaps.get(where);
    if (!s) this.snaps.set(where, (s = this.list.filter((x) => x.where === where)));
    return s;
  }
  get(id: string): Send | undefined {
    return this.list.find((s) => s.id === id);
  }
  /** A start's screen is open (it reverses on a refusal itself). */
  showing(id: string): () => void {
    this.shown.add(id);
    return () => void this.shown.delete(id);
  }

  // ---- sending

  /** A message into a conversation (`conv:`) or a chat (`chat:`): shown now, confirmed by the Mac. */
  message(topic: Topic, text: string, call: Call | Prepare, opts: { photo?: boolean; on?: string } = {}): void {
    const where = whereOf(topic, opts.on);
    const id = this.add({ where, text, seen: mine(where).map((m) => m.id), ...(opts.photo ? { photo: true } : {}), ...(opts.on ? { on: opts.on } : {}) }, call);
    this.watchTopic(where);
    this.run(id);
  }

  /** A start from Ask → its id, for its screen (`/starting/<id>`). */
  start(start: Start, text: string, call: Call | Prepare, opts: { photo?: boolean; on?: string } = {}): string {
    const id = this.add({ where: '', text, seen: [], start, ...(opts.photo ? { photo: true } : {}), ...(opts.on ? { on: opts.on } : {}) }, call);
    this.patch(id, { where: `new:${id}` });
    // Ask opens its screen next: until that screen closes, it reverses a refusal itself.
    this.shown.add(id);
    this.run(id);
    return id;
  }

  retry(id: string): void {
    const s = this.get(id);
    if (!s || (s.state !== 'failed' && s.state !== 'unsure')) return;
    this.patch(id, { state: 'sending', error: undefined });
    this.run(id);
  }

  remove(id: string): void {
    this.list = this.list.filter((s) => s.id !== id);
    this.prepares.delete(id);
    this.changed();
  }

  private add(s: Omit<Send, 'id' | 'at' | 'state'>, call: Call | Prepare): string {
    const id = `s${Date.now().toString(36)}${this.seq++}`;
    const prepared = typeof call === 'function' ? undefined : call;
    if (typeof call === 'function') this.prepares.set(id, call);
    this.list = [...this.list, { ...s, id, at: Date.now(), state: 'sending', ...(prepared ? { call: prepared } : {}) }];
    this.changed();
    return id;
  }

  private async run(id: string): Promise<void> {
    const s = this.get(id);
    if (!s) return;
    // A chat with your Mac away goes through your Always On, which runs your friends network (BLG-850).
    const on = s.on ?? (s.where.startsWith('chat:') && !store.linked ? store.friendsOn() : undefined);
    // On a computer: over its own link now, or not at all (nothing waits for a computer that's away).
    if (on && !store.linkedTo(on)) return this.fail(id, `${store.computerName(on) ?? 'That computer'} is away.`);
    if (!on && !store.linked) {
      // A photo goes up only while linked; everything else waits for the Mac.
      if (s.photo && !s.call) return this.fail(id, 'Your Mac is away, and a photo only goes while it answers.');
      return this.patch(id, { state: 'waiting' });
    }
    this.patch(id, { state: 'sending' });
    let call = s.call;
    try {
      if (!call) {
        call = await this.prepares.get(id)!();
        this.prepares.delete(id);
        this.patch(id, { call });
      }
    } catch (e) {
      return this.fail(id, (e as Error).message);
    }
    store.call<unknown>(call, { queue: false, ...(on ? { on } : {}) }).then(
      (value) => this.onOk(id, value),
      (e: Error & { lost?: boolean }) => (e.lost ? this.onLost(id) : this.fail(id, e.message)),
    );
  }

  private onOk(id: string, value: unknown): void {
    const s = this.get(id);
    if (!s) return;
    if (!s.start) {
      this.patch(id, { state: 'sent' });
      this.reconcile(s.where);
      setTimeout(() => this.get(id)?.state === 'sent' && this.remove(id), SHOWN_WITHIN_MS);
      return;
    }
    // Where the start went: a worktree by its id (with photos, by its topic), a plan, or the conversation a question opened.
    const back = value as { topic?: Topic; id?: string } | string | undefined;
    const topic = s.start.kind === 'worktree' && typeof back === 'string' ? (`conv:ws:${back}` as Topic) : typeof back === 'object' && back?.topic ? back.topic : undefined;
    const plan = s.start.kind === 'plan' && typeof back === 'object' && back?.id ? back.id : undefined;
    if (!topic && !plan) return this.fail(id, s.start.kind === 'worktree' ? "Your Mac couldn't make the worktree." : "Your Mac didn't start it.");
    this.patch(id, { state: 'sent', ...(topic ? { topic } : {}), ...(plan ? { plan } : {}) });
    if (!this.shown.has(id)) store.toast({ text: `Started: ${short(s.text)}`, tone: 'ok', ...(topic ? { topic } : {}) });
    setTimeout(() => this.remove(id), START_KEPT_MS);
  }

  /** The link dropped before the Mac answered: it may have it. */
  private onLost(id: string): void {
    const s = this.get(id);
    if (!s) return;
    if (s.start) return this.fail(id, 'Your Mac went away before it answered. Check Work before trying again.');
    this.patch(id, { state: 'unsure' });
  }

  private fail(id: string, error: string): void {
    const s = this.get(id);
    if (!s) return;
    if (s.start && !this.shown.has(id)) {
      // Nobody is looking at it: say so, and give Ask the words back.
      this.draft = { text: s.text, target: s.start.target, how: s.start.kind };
      store.toast({ text: `Didn't start "${short(s.text)}": ${error}`, tone: 'error' });
      return this.remove(id);
    }
    this.patch(id, { state: 'failed', error });
  }

  private onLinked(): void {
    for (const s of this.list) if (s.state === 'waiting') this.run(s.id);
  }

  // ---- checking against the Mac's views

  private watchTopic(where: string): void {
    const { topic } = splitWhere(where);
    if (this.watched.has(where) || !(topic.startsWith('conv:') || topic.startsWith('chat:'))) return;
    this.watched.add(where);
    store.subscribe(`view:${where}`, () => this.reconcile(where));
  }

  /** Bubbles the Mac's view now shows go; unsure ones it doesn't show, after the link came back, didn't get there. */
  private reconcile(where: string): void {
    const waiting = this.list.filter((s) => s.where === where && (s.state === 'sent' || s.state === 'unsure' || s.state === 'sending'));
    if (!waiting.length) return;
    const { on, topic } = splitWhere(where);
    const view = on ? store.viewOn(on, topic) : store.view(topic);
    const items = mine(where);
    const claimed = new Set<string>();
    const gone: string[] = [];
    for (const s of waiting) {
      const unseen = items.filter((m) => !s.seen.includes(m.id) && !claimed.has(m.id));
      // The same words (code comes back as a chip, so the start of them); a confirmed one takes any new message of yours.
      const hit = unseen.find((m) => same(m.text, s.text)) ?? (s.state === 'sent' ? unseen[0] : undefined);
      if (hit) {
        claimed.add(hit.id);
        gone.push(s.id);
      }
    }
    if (gone.length) {
      this.list = this.list.filter((s) => !gone.includes(s.id));
      this.changed();
    }
    // A view straight from the Mac after the link came back, without it: it didn't get there.
    if (view && !view.stale && (on ? store.linkedTo(on) : store.linked || Boolean(store.friendsOn()))) for (const s of this.list) if (s.where === where && s.state === 'unsure') this.patch(s.id, { state: 'failed', error: "It didn't reach your Mac." });
  }

  // ---- state

  private patch(id: string, p: Partial<Omit<Send, 'id'>>): void {
    this.list = this.list.map((s) => (s.id === id ? ({ ...s, ...p } as Send) : s));
    this.changed();
  }
  private changed(): void {
    this.snaps.clear();
    // A photo's bytes aren't kept; neither is a send that can't be made again without them.
    kv.set('sends', this.list.filter((s) => s.call));
    for (const fn of [...this.listeners]) fn();
  }
}

/** Where a message shows: its topic, under its computer's id when it's on one (as that computer's views are keyed). */
export const whereOf = (topic: Topic, on?: string): string => (on ? `${on}|${topic}` : topic);
const splitWhere = (where: string): { on?: string; topic: Topic } => {
  const bar = where.indexOf('|');
  return bar < 0 ? { topic: where as Topic } : { on: where.slice(0, bar), topic: where.slice(bar + 1) as Topic };
};

/** Your messages in a conversation (and its queue) or a chat, as the cached view has them. */
function mine(where: string): { id: string; text: string }[] {
  const { on, topic } = splitWhere(where);
  const v = (on ? store.viewOn<ConvView | ChatView>(on, topic) : store.view<ConvView | ChatView>(topic))?.data;
  if (!v) return [];
  if (topic.startsWith('chat:')) return (v as ChatView).messages.filter((m) => m.mine).map((m) => ({ id: m.id, text: m.text }));
  const c = v as ConvView;
  return [...c.turns.filter((t) => t.who === 'you').map((t) => ({ id: t.id, text: t.prose.text })), ...(c.queue ?? []).map((q) => ({ id: q.id, text: q.text }))];
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
function same(a: string, b: string): boolean {
  const x = norm(a).slice(0, 40);
  const y = norm(b).slice(0, 40);
  if (!x || !y) return !x && !y;
  return x.startsWith(y.slice(0, 24)) || y.startsWith(x.slice(0, 24));
}
const short = (t: string): string => (t.length > 32 ? `${t.slice(0, 31)}…` : t);

export const sends = new Sends();

/** What waits to be confirmed in a conversation or chat (or a start's screen: `new:<id>`), oldest first. */
export function useSends(where: string): readonly Send[] {
  return useSyncExternalStore(
    (fn) => sends.subscribe(fn),
    () => sends.of(where),
  );
}

export function useSend(id: string | undefined): Send | undefined {
  return useSyncExternalStore(
    (fn) => sends.subscribe(fn),
    () => (id ? sends.get(id) : undefined),
  );
}
