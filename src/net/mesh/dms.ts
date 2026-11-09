import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ExtrasSchema, parseExtras } from './extras.js';
import { appendLine, readJson, readLines, safeName, writeJson } from './files.js';
import type { ChatExtras } from './views.js';

/**
 * Direct messages with friends: each conversation kept in ~/.beluga/dms/<peer>.jsonl, and what
 * you sent while they were offline in your outbox (~/.beluga/outbox.json) until their Mac says
 * it got it, or until it expires. The file is only ever appended to: a deleted message, an edit
 * or a cleared chat is a line of its own, applied when the file is read back (BLG-425). Deleting
 * or editing your own message for both of you also waits in ~/.beluga/dm-changes.json until their
 * Mac says it got it, like a message.
 */

export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OUTBOX = 2_000;

export interface Dm {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly ts: number;
  /** Files, a call for Claudes, or a Claude's answer (see extras.ts). */
  readonly x?: ChatExtras;
  /** When its author last changed its text. */
  readonly edited?: number;
}

/** Deleting or editing your own message on a friend's Mac too: sent until they confirm it. */
export interface DmChange {
  readonly to: string;
  readonly id: string;
  /** The new text; none: the message is deleted. */
  readonly text?: string;
  readonly at: number;
}

const DmLine = z.union([
  z.object({ id: z.string(), from: z.string(), to: z.string(), text: z.string(), ts: z.number(), x: ExtrasSchema.optional() }),
  z.object({ ack: z.string() }),
  /** They saw your messages up to this one (BLG-798). */
  z.object({ seen: z.string() }),
  z.object({ expired: z.string() }),
  /** Gone from this conversation (deleted here, or by its author for both of you). */
  z.object({ del: z.string() }),
  z.object({ edit: z.string(), text: z.string(), at: z.number() }),
  /** Cleared on this Mac: everything before is gone. */
  z.object({ cleared: z.number() }),
]);

const Change = z.object({ to: z.string(), id: z.string(), text: z.string().optional(), at: z.number() });
const MAX_CHANGES = 2_000;

const Outgoing = z.object({ id: z.string(), from: z.string(), to: z.string(), text: z.string(), ts: z.number(), x: ExtrasSchema.optional(), expiresAt: z.number() });
type Outgoing = Dm & { readonly expiresAt: number };

/** A stored line or outbox record as a message (extras checked again: the file could be old or edited). */
function toDm(v: { id: string; from: string; to: string; text: string; ts: number; x?: unknown }): Dm {
  const x = parseExtras(v.x);
  return { id: v.id, from: v.from, to: v.to, text: v.text, ts: v.ts, ...(x ? { x } : {}) };
}

export interface DmStatus {
  readonly delivered: ReadonlySet<string>;
  readonly expired: ReadonlySet<string>;
  /** Your messages they saw (BLG-798). */
  readonly seen: ReadonlySet<string>;
}

interface Conversation {
  messages: Dm[];
  readonly ids: Set<string>;
  readonly delivered: Set<string>;
  readonly expired: Set<string>;
  readonly seen: Set<string>;
  /** Deleted ids, so a message resent after it was deleted stays gone. */
  readonly deleted: Set<string>;
}

export class DmBook {
  private readonly conversations = new Map<string, Conversation>();
  private outbox: readonly Outgoing[];
  private changes: readonly DmChange[];

  constructor(private readonly dir: string) {
    const raw = readJson(path.join(dir, 'outbox.json'));
    this.outbox = (Array.isArray(raw) ? raw : []).flatMap((o) => {
      const parsed = Outgoing.safeParse(o);
      return parsed.success ? [{ ...toDm(parsed.data), expiresAt: parsed.data.expiresAt }] : [];
    });
    const changes = readJson(path.join(dir, 'dm-changes.json'));
    this.changes = (Array.isArray(changes) ? changes : []).flatMap((c) => {
      const parsed = Change.safeParse(c);
      return parsed.success ? [stripUndefined(parsed.data)] : [];
    });
  }

  /** A conversation's messages, oldest first. */
  history(peerId: string): readonly Dm[] {
    return this.load(peerId).messages;
  }

  status(peerId: string): DmStatus {
    return this.load(peerId);
  }

  /** Waiting in the outbox for this friend. */
  waiting(peerId: string): readonly Outgoing[] {
    return this.outbox.filter((o) => o.to === peerId && o.expiresAt > Date.now());
  }

  /** Write a message to a friend: kept in the conversation and in the outbox until they confirm. */
  compose(from: string, to: string, text: string, x?: ChatExtras): Dm {
    if (this.outbox.length >= MAX_OUTBOX) throw new Error('Your outbox is full; wait for friends to come online');
    const dm: Dm = { id: randomBytes(12).toString('base64url'), from, to, text, ts: Date.now(), ...(x ? { x } : {}) };
    this.record(to, dm);
    this.saveOutbox([...this.outbox, { ...dm, expiresAt: dm.ts + OUTBOX_TTL_MS }]);
    return dm;
  }

  /** A message from a friend; false when it's one we already have (or deleted). */
  receive(dm: Dm): boolean {
    const c = this.load(dm.from);
    if (c.ids.has(dm.id) || c.deleted.has(dm.id)) return false;
    this.record(dm.from, dm);
    return true;
  }

  /** They got it: off the outbox. Returns the message when it was ours and waiting. */
  delivered(peerId: string, id: string): Dm | undefined {
    const waiting = this.outbox.find((o) => o.id === id && o.to === peerId);
    if (!waiting) return undefined;
    this.saveOutbox(this.outbox.filter((o) => o !== waiting));
    const c = this.load(peerId);
    c.delivered.add(id);
    appendLine(this.file(peerId), { ack: id });
    return c.messages.find((m) => m.id === id);
  }

  /**
   * They saw your messages up to `id` (one of yours): each of yours before it is seen too. Returns the
   * ones that just became seen (none when `id` isn't yours here, or they all were).
   */
  seenBy(peerId: string, id: string): Dm[] {
    const c = this.load(peerId);
    const fresh = this.markSeen(c, peerId, id);
    if (fresh.length) appendLine(this.file(peerId), { seen: id });
    return fresh;
  }

  private markSeen(c: Conversation, peerId: string, id: string): Dm[] {
    const at = c.messages.findIndex((m) => m.id === id);
    if (at < 0 || c.messages[at]!.from === peerId) return [];
    const fresh = c.messages.slice(0, at + 1).filter((m) => m.from !== peerId && !c.seen.has(m.id));
    for (const m of fresh) {
      c.seen.add(m.id);
      c.delivered.add(m.id);
    }
    return fresh;
  }

  /** Drop what waited too long; returns what expired. */
  expire(now = Date.now()): Dm[] {
    const gone = this.outbox.filter((o) => o.expiresAt <= now);
    if (!gone.length) return [];
    this.saveOutbox(this.outbox.filter((o) => o.expiresAt > now));
    return gone.map((o) => {
      const c = this.load(o.to);
      c.expired.add(o.id);
      appendLine(this.file(o.to), { expired: o.id });
      return toDm(o);
    });
  }

  /** A message in this conversation, by id. */
  find(peerId: string, id: string): Dm | undefined {
    return this.load(peerId).messages.find((m) => m.id === id);
  }

  /**
   * Delete a message from this conversation here. `everyone`: it's yours and goes from their Mac
   * too (one still in the outbox never leaves). Returns the change to send them, if any.
   */
  delete(peerId: string, id: string, everyone: boolean): DmChange | undefined {
    const c = this.load(peerId);
    const dm = c.messages.find((m) => m.id === id);
    if (!dm) throw new Error('No such message');
    if (everyone && dm.from === peerId) throw new Error('You can only delete your own messages for everyone');
    this.drop(c, id);
    appendLine(this.file(peerId), { del: id });
    if (!everyone) return undefined;
    const waiting = this.outbox.some((o) => o.id === id);
    if (waiting) this.saveOutbox(this.outbox.filter((o) => o.id !== id));
    return this.queue({ to: peerId, id, at: Date.now() });
  }

  /** Change the text of a message you sent: here, and on their Mac. Returns the change to send. */
  edit(peerId: string, id: string, text: string): { dm: Dm; change: DmChange } {
    const c = this.load(peerId);
    const dm = c.messages.find((m) => m.id === id);
    if (!dm) throw new Error('No such message');
    if (dm.from === peerId) throw new Error('You can only edit your own messages');
    const at = Date.now();
    const next = this.rewrite(c, id, text, at)!;
    appendLine(this.file(peerId), { edit: id, text, at });
    // Not sent yet: it goes with its new text (the change still follows, for a copy already in a mailbox).
    if (this.outbox.some((o) => o.id === id)) this.saveOutbox(this.outbox.map((o) => (o.id === id ? { ...o, text } : o)));
    return { dm: next, change: this.queue({ to: peerId, id, text, at }) };
  }

  /**
   * A friend deleted or edited a message of theirs. Returns the message as it is now (undefined
   * once deleted), or null when there was nothing to change (not theirs, an older edit, already gone).
   */
  changed(peerId: string, change: { id: string; text?: string; at: number }): Dm | undefined | null {
    const c = this.load(peerId);
    const dm = c.messages.find((m) => m.id === change.id);
    if (dm && dm.from !== peerId) return null;
    if (change.text === undefined) {
      if (c.deleted.has(change.id)) return null;
      this.drop(c, change.id);
      appendLine(this.file(peerId), { del: change.id });
      return undefined;
    }
    if (!dm || (dm.edited ?? 0) >= change.at) return null;
    appendLine(this.file(peerId), { edit: change.id, text: change.text, at: change.at });
    return this.rewrite(c, change.id, change.text, change.at) ?? null;
  }

  /** They got a change: stop sending it. */
  changeDelivered(peerId: string, id: string, at: number): void {
    const next = this.changes.filter((c) => !(c.to === peerId && c.id === id && c.at <= at));
    if (next.length !== this.changes.length) this.saveChanges(next);
  }

  /** Changes still waiting for this friend. */
  pendingChanges(peerId: string): readonly DmChange[] {
    return this.changes.filter((c) => c.to === peerId);
  }

  /** Clear this conversation on this Mac (theirs keeps its copy). Returns how many messages went. */
  clear(peerId: string): number {
    const c = this.load(peerId);
    const gone = c.messages.length;
    for (const m of c.messages) c.deleted.add(m.id);
    c.messages = [];
    appendLine(this.file(peerId), { cleared: Date.now() });
    return gone;
  }

  /** Forget a friend's conversation in memory and drop what waits for them (the file stays). */
  forget(peerId: string): void {
    this.conversations.delete(peerId);
    this.saveOutbox(this.outbox.filter((o) => o.to !== peerId));
    this.saveChanges(this.changes.filter((c) => c.to !== peerId));
  }

  private file(peerId: string): string {
    return path.join(this.dir, 'dms', `${safeName(peerId)}.jsonl`);
  }

  private record(peerId: string, dm: Dm): void {
    const c = this.load(peerId);
    c.messages.push(dm);
    c.ids.add(dm.id);
    appendLine(this.file(peerId), dm);
  }

  private drop(c: Conversation, id: string): void {
    c.messages = c.messages.filter((m) => m.id !== id);
    c.deleted.add(id);
  }

  private rewrite(c: Conversation, id: string, text: string, at: number): Dm | undefined {
    let next: Dm | undefined;
    c.messages = c.messages.map((m) => (m.id === id ? (next = { ...m, text, edited: at }) : m));
    return next;
  }

  /** One change per message waits: a newer one replaces what's queued. */
  private queue(change: DmChange): DmChange {
    const rest = this.changes.filter((c) => !(c.to === change.to && c.id === change.id));
    if (rest.length >= MAX_CHANGES) throw new Error('Too many changes waiting; wait for friends to come online');
    this.saveChanges([...rest, change]);
    return change;
  }

  private load(peerId: string): Conversation {
    const known = this.conversations.get(peerId);
    if (known) return known;
    const c: Conversation = { messages: [], ids: new Set(), delivered: new Set(), expired: new Set(), seen: new Set(), deleted: new Set() };
    for (const raw of readLines(this.file(peerId))) {
      const line = DmLine.safeParse(raw);
      if (!line.success) continue;
      const v = line.data;
      if ('ack' in v) c.delivered.add(v.ack);
      else if ('seen' in v) this.markSeen(c, peerId, v.seen);
      else if ('expired' in v) c.expired.add(v.expired);
      else if ('del' in v) this.drop(c, v.del);
      else if ('edit' in v) this.rewrite(c, v.edit, v.text, v.at);
      else if ('cleared' in v) {
        for (const m of c.messages) c.deleted.add(m.id);
        c.messages = [];
      } else if (!c.ids.has(v.id) && !c.deleted.has(v.id)) {
        c.messages.push(toDm(v));
        c.ids.add(v.id);
      }
    }
    this.conversations.set(peerId, c);
    return c;
  }

  private saveOutbox(next: readonly Outgoing[]): void {
    this.outbox = next;
    writeJson(path.join(this.dir, 'outbox.json'), next);
  }

  private saveChanges(next: readonly DmChange[]): void {
    this.changes = next;
    writeJson(path.join(this.dir, 'dm-changes.json'), next);
  }
}

const stripUndefined = (c: { to: string; id: string; text?: string | undefined; at: number }): DmChange => ({ to: c.to, id: c.id, at: c.at, ...(c.text !== undefined ? { text: c.text } : {}) });
