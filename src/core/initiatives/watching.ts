import type { OnceTrigger, SentinelDraft, SentinelPatch } from '../sentinel/model.js';
import { addTimeline, readFolder, writeOutbox, writeWatches } from './files.js';
import { type OutboxDraft, initiativeChatChannel } from './model.js';
import { dayOf } from './repo.js';
import { captureQuestionAnswers, linkSentQuestionDraft } from './question-records.js';
import { isRetired } from './questions.js';
import { watchPrompt } from './watch-prompt.js';
import { WATCH_CHAT, type Watch, type WatchDraft, WatchDraftSchema, WatchSchema, dueWatches, needsNudge, isExpired, isWatching, nextLookWhen, nextWakeAt, nextWatchId, watchOfDraft } from './watches.js';

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
  /** Lists the Follow-ups chat, so the sentinel finds the chat it wakes. */
  readonly ensureChat: (slug: string) => void;
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

  /** A sent Slack message or Jira comment: watch its place for the answer (written now; the chat turn's end commits it). A Confluence section gets none. */
  fromDraft(slug: string, draft: OutboxDraft): void {
    if ((draft.to.kind !== 'slack' && draft.to.kind !== 'jira') || draft.reminderFor) return;
    const folder = readFolder(this.deps.root, slug);
    const watches = folder.watches;
    if (draft.question) {
      const question = folder.questions.find((entry) => entry.id === draft.question && !isRetired(entry));
      if (!question) return;
      const linked = linkSentQuestionDraft(watches, question, draft, this.deps.now());
      if (linked.some((watch, index) => watch !== watches[index])) writeWatches(this.deps.root, slug, linked);
      return;
    }
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
  turnEnded(slug: string, completed: boolean): void {
    const now = this.deps.now();
    const watches = this.read(slug);
    const ids = new Set([...dueWatches(watches, now).map((w) => w.id), ...(this.asked.get(slug) ?? [])]);
    this.asked.delete(slug);
    if (ids.size) this.put(slug, watches, (watch) => ({
      ...watch,
      lastLook: new Date(now).toISOString(),
      ...(watch.question ? { checkFailed: !completed || !watch.checkedAt || Date.parse(watch.checkedAt) > now || Boolean(watch.lastLook && Date.parse(watch.checkedAt) <= Date.parse(watch.lastLook)) } : {}),
    }), ids);
    if (completed) this.draftReminders(slug, ids, now);
  }

  private draftReminders(slug: string, ids: ReadonlySet<number>, now: number): void {
    const folder = readFolder(this.deps.root, slug);
    const outbox = [...folder.outbox];
    const reminded = new Set<number>();
    let id = outbox.reduce((max, draft) => Math.max(max, draft.id), 0);
    for (const watch of folder.watches) {
      const question = folder.questions.find((entry) => entry.id === watch.question);
      if (!ids.has(watch.id) || !question || question.answer || isRetired(question) || !needsNudge(watch, now) || isExpired(watch, now)) continue;
      if (watch.checkFailed || !watch.checkedAt || !needsNudge(watch, Date.parse(watch.checkedAt)) || Date.parse(watch.checkedAt) > now) continue;
      if ((watch.where.kind !== 'slack' && watch.where.kind !== 'jira') || outbox.length >= 500) continue;
      if (!outbox.some((draft) => draft.reminderFor === watch.id)) {
        outbox.push({
          id: ++id, to: watch.where, question: question.id, reminderFor: watch.id,
          text: `Quick follow-up on this question: ${question.text} Do you have an update?`,
          state: 'draft', createdAt: new Date(now).toISOString(),
        });
      }
      reminded.add(watch.id);
    }
    if (!reminded.size) return;
    if (outbox.length !== folder.outbox.length) writeOutbox(this.deps.root, slug, outbox);
    this.put(slug, folder.watches, (watch) => ({ ...watch, nudgedAt: new Date(now).toISOString() }), reminded);
  }

  /** Gives up on the watches past their time (a timeline line each), then arms the sentinel for the next due one. */
  async sync(slug: string): Promise<void> {
    const now = this.deps.now();
    const folder = readFolder(this.deps.root, slug);
    const linked = new Set(folder.watches.map((watch) => watch.draft));
    const restored = folder.outbox.reduce((watches, draft) => {
      if (!draft.question || draft.state !== 'sent' || draft.reminderFor || linked.has(draft.id)) return watches;
      const question = folder.questions.find((record) => record.id === draft.question && !isRetired(record));
      return question ? linkSentQuestionDraft(watches, question, draft, now) : watches;
    }, folder.watches);
    if (restored !== folder.watches) writeWatches(this.deps.root, slug, restored);
    const changed = captureQuestionAnswers(this.deps.root, { ...folder, watches: restored });
    const current = changed || restored !== folder.watches ? readFolder(this.deps.root, slug) : folder;
    const active = new Set(current.watches.filter((watch) => isWatching(watch) && !isExpired(watch, now) && !watch.news.length).map((watch) => watch.id));
    const stale = current.outbox.filter((draft) => draft.state === 'draft' && draft.reminderFor && !active.has(draft.reminderFor));
    if (stale.length) {
      const ids = new Set(stale.map((draft) => draft.id));
      writeOutbox(this.deps.root, slug, current.outbox.map((draft) => ids.has(draft.id) ? { ...draft, state: 'discarded', resolvedAt: new Date(now).toISOString() } : draft));
    }
    if (changed || restored !== folder.watches || stale.length) {
      await this.deps.commit(slug, `${slug}: follow-up answers`);
      this.deps.refresh(slug);
    }
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
    this.deps.ensureChat(slug);
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
