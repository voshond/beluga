import type { OnceTrigger, SentinelDraft, SentinelPatch } from '../sentinel/model.js';
import { addTimeline, readFolder, writeWatches } from './files.js';
import { type OutboxDraft, initiativeChatChannel } from './model.js';
import { dayOf } from './repo.js';
import { watchPrompt } from './watch-prompt.js';
import { WATCH_CHAT, type Watch, type WatchDraft, WatchDraftSchema, WatchSchema, dueWatches, isExpired, isWatching, nextLookWhen, nextWakeAt, nextWatchId, watchOfDraft } from './watches.js';

/** What the watch sentinel needs from Sentinel (launch.ts builds it, as the check-in's). */
export type WatchHost = {
  readonly create: (draft: SentinelDraft) => { readonly id: string };
  readonly exists: (id: string) => boolean;
  readonly pause: (id: string, paused: boolean) => void;
  readonly rewrite: (id: string, patch: Pick<SentinelPatch, 'trigger' | 'steps'>) => void;
};

export type WatchingDeps = {
  readonly root: string;
  readonly now: () => number;
  readonly selfId: () => string;
  readonly ask: (prompt: string, channel: string) => string | undefined;
  readonly host: () => WatchHost | undefined;
  /** The initiative's watch sentinel on this computer (local.json), and keeping a new one there. */
  readonly sentinel: (slug: string) => string | undefined;
  readonly keepSentinel: (slug: string, id: string) => void;
  readonly commit: (slug: string, message: string) => Promise<void>;
  readonly refresh: (slug: string) => void;
  /** Its name, and whether it is followed at all (an archived one watches nothing). */
  readonly about: (slug: string) => { readonly name: string; readonly active: boolean };
};

/** A once trigger must be in the future when it is set. */
const LEAD_MS = 60_000;

/**
 * Follow-ups an initiative waits for (watches.json). The daemon decides when a look is due and
 * arms the initiative's watch sentinel for that moment; only the agent looks (Slack, Jira, docs).
 */
export class InitiativeWatches {
  private readonly asked = new Map<string, Set<number>>();

  constructor(private readonly deps: WatchingDeps) {}

  private read(slug: string): readonly Watch[] {
    return readFolder(this.deps.root, slug).watches;
  }

  private put(slug: string, watches: readonly Watch[], change: (watch: Watch) => Watch, ids: ReadonlySet<number>): void {
    writeWatches(this.deps.root, slug, watches.map((w) => (ids.has(w.id) ? change(w) : w)));
  }

  private need(slug: string, id: number): { readonly watches: readonly Watch[]; readonly watch: Watch } {
    const watches = this.read(slug);
    const watch = watches.find((w) => w.id === id);
    if (!watch) throw new Error('That follow-up is gone');
    return { watches, watch };
  }

  async add(slug: string, draft: WatchDraft): Promise<Watch> {
    const parsed = WatchDraftSchema.parse(draft);
    const watches = this.read(slug);
    const watch = WatchSchema.parse({ ...parsed, id: nextWatchId(watches), since: new Date(this.deps.now()).toISOString() });
    writeWatches(this.deps.root, slug, [...watches, watch]);
    await this.settle(slug, `${slug}: watching ${watch.id}`);
    return watch;
  }

  /** A sent draft: watch its place for the answer (written now; the chat turn's end commits it). */
  fromDraft(slug: string, draft: OutboxDraft): void {
    const watches = this.read(slug);
    if (watches.some((w) => w.draft === draft.id)) return;
    writeWatches(this.deps.root, slug, [...watches, watchOfDraft(draft, nextWatchId(watches), this.deps.now())]);
  }

  async stop(slug: string, id: number): Promise<void> {
    const { watches, watch } = this.need(slug, id);
    if (!isWatching(watch)) throw new Error(`That follow-up is ${watch.state} already`);
    this.put(slug, watches, (w) => ({ ...w, state: 'stopped' }), new Set([id]));
    await this.settle(slug, `${slug}: stopped watching ${id}`);
  }

  /** "New since you asked" read: one watch's news, or all of them. */
  async markRead(slug: string, id?: number): Promise<void> {
    const watches = this.read(slug);
    const ids = new Set(watches.filter((w) => (id === undefined || w.id === id) && w.news.some((n) => !n.read)).map((w) => w.id));
    if (!ids.size) return;
    this.put(slug, watches, (w) => ({ ...w, news: w.news.map((n) => ({ ...n, read: true })) }), ids);
    await this.deps.commit(slug, `${slug}: follow-up news read`);
    this.deps.refresh(slug);
  }

  /** Look Now: the Follow-ups chat looks at this one watch at once. */
  look(slug: string, id: number): { readonly channel: string } {
    const { watch } = this.need(slug, id);
    if (!isWatching(watch)) throw new Error(`That follow-up is ${watch.state}`);
    const channel = initiativeChatChannel(slug, WATCH_CHAT);
    if (this.deps.ask(watchPrompt([watch], this.deps.now()), channel) === undefined) throw new Error('The look could not start');
    this.asked.set(slug, new Set([...(this.asked.get(slug) ?? []), id]));
    return { channel };
  }

  /** A turn in the Follow-ups chat ended: the watches it looked at move their last look (before the commit). */
  turnEnded(slug: string): void {
    const now = this.deps.now();
    const watches = this.read(slug);
    const ids = new Set([...dueWatches(watches, now).map((w) => w.id), ...(this.asked.get(slug) ?? [])]);
    this.asked.delete(slug);
    if (ids.size) this.put(slug, watches, (w) => ({ ...w, lastLook: new Date(now).toISOString() }), ids);
  }

  /** Gives up on the watches past their time (a timeline line each), then arms the sentinel for the next due one. */
  async sync(slug: string): Promise<void> {
    const now = this.deps.now();
    const watches = this.read(slug);
    const expired = watches.filter((w) => isExpired(w, now));
    if (expired.length) {
      this.put(slug, watches, (w) => ({ ...w, state: 'expired' }), new Set(expired.map((w) => w.id)));
      for (const w of expired) addTimeline(this.deps.root, slug, `${dayOf(now)} [follow-up]: stopped waiting: ${w.what}${w.waitingOn ? ` (${w.waitingOn})` : ''} got no answer`);
      await this.deps.commit(slug, `${slug}: follow-ups expired`);
      this.deps.refresh(slug);
    }
    this.arm(slug);
  }

  private async settle(slug: string, message: string): Promise<void> {
    await this.deps.commit(slug, message);
    this.deps.refresh(slug);
    this.arm(slug);
  }

  /** Arms the watch sentinel; Sentinel refusing (no chats to wake here) leaves the watches as they are. */
  private arm(slug: string): void {
    try {
      this.armSentinel(slug);
    } catch {
      return;
    }
  }

  /** The watch sentinel fires once, at the next due moment, naming the watches due then; with nothing to watch it pauses. */
  private armSentinel(slug: string): void {
    const host = this.deps.host();
    if (!host) return;
    const about = this.deps.about(slug);
    const watches = about.active ? this.read(slug) : [];
    const now = this.deps.now();
    const known = this.deps.sentinel(slug);
    const id = known && host.exists(known) ? known : undefined;
    const next = nextWakeAt(watches, now);
    if (next === undefined) {
      if (id) host.pause(id, true);
      return;
    }
    const at = Math.max(next, now + LEAD_MS);
    const due = watches.filter((w) => isWatching(w) && nextLookWhen(w, now) <= at);
    const trigger: OnceTrigger = { kind: 'once', at: new Date(at).toISOString(), missed: 'catch-up' };
    const steps = [{ kind: 'chat' as const, to: `${this.deps.selfId()}/${initiativeChatChannel(slug, WATCH_CHAT)}`, text: watchPrompt(due, at) }];
    if (id) host.rewrite(id, { trigger, steps });
    const armed = id ?? host.create({ name: `${about.name} follow-ups`.slice(0, 80), icon: 'eye', projectId: null, trigger, steps, access: 'look', notify: 'off' }).id;
    if (!id) this.deps.keepSentinel(slug, armed);
    host.pause(armed, false);
  }
}
