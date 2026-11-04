import path from 'node:path';
import { z } from 'zod';
import { EmojiSchema, type Reaction, type ReactionEvent, applyReaction, foldReactions, reactionsOf } from '../../shared/reactions.js';
import { appendLine, readJson, readLines, safeName, writeJson, writeLines } from './files.js';

/**
 * Reactions in direct messages (BLG-702), next to the messages: each friend's in
 * ~/.beluga/dms/<peer>.reactions.jsonl, a line per change (the newest per emoji and person wins
 * when it's read back, see shared/reactions.ts). Your own changes also wait in
 * ~/.beluga/dm-reactions.json until their Mac says it got them, like a message in the outbox.
 */

const MAX_WAITING = 2_000;

export const MessageIdSchema = z.string().regex(/^[\w-]{8,64}$/);

const Line = z.object({ id: MessageIdSchema, e: EmojiSchema, by: z.string().regex(/^[\w-]{1,64}$/), on: z.boolean(), at: z.number().int().min(0) });
const Waiting = z.object({ to: z.string().regex(/^[\w-]{1,64}$/), id: MessageIdSchema, e: EmojiSchema, on: z.boolean(), at: z.number().int().min(0) });

/** One of your changes on its way to a friend. */
export type WaitingReaction = z.infer<typeof Waiting>;

const eventOf = (l: z.infer<typeof Line>): ReactionEvent => ({ id: l.id, emoji: l.e, by: l.by, on: l.on, at: l.at });
const lineOf = (e: ReactionEvent) => ({ id: e.id, e: e.emoji, by: e.by, on: e.on, at: e.at });

export class DmReactions {
  /** Per friend: each message's changes. */
  private readonly loaded = new Map<string, Map<string, readonly ReactionEvent[]>>();
  private waitingList: readonly WaitingReaction[];

  constructor(private readonly dir: string) {
    const raw = readJson(this.waitingFile);
    this.waitingList = (Array.isArray(raw) ? raw : []).flatMap((w) => {
      const parsed = Waiting.safeParse(w);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** The chips under one message (empty: none). */
  of(peerId: string, id: string): Reaction[] {
    return reactionsOf(this.load(peerId).get(id) ?? []);
  }

  /** When a new change of `by`'s to this emoji happens: now, or just after their last one if the clock went back. */
  nextAt(peerId: string, id: string, emoji: string, by: string): number {
    const last = this.load(peerId).get(id)?.find((e) => e.emoji === emoji && e.by === by)?.at ?? 0;
    return Math.max(Date.now(), last + 1);
  }

  /** Your change: kept here and waiting for them. → the message's chips now. */
  mine(peerId: string, event: ReactionEvent): Reaction[] {
    this.take(peerId, event);
    const rest = this.waitingList.filter((w) => !(w.to === peerId && w.id === event.id && w.e === event.emoji));
    if (rest.length >= MAX_WAITING) throw new Error('Too many reactions waiting; wait for friends to come online');
    this.saveWaiting([...rest, { to: peerId, id: event.id, e: event.emoji, on: event.on, at: event.at }]);
    return this.of(peerId, event.id);
  }

  /** A friend's change (already checked): true when it changed what the message shows. */
  theirs(peerId: string, event: ReactionEvent): boolean {
    return this.take(peerId, event);
  }

  /** Changes still waiting for this friend. */
  waiting(peerId: string): readonly WaitingReaction[] {
    return this.waitingList.filter((w) => w.to === peerId);
  }

  /** They got it: stop sending it (a newer change for the same emoji keeps waiting). */
  delivered(peerId: string, id: string, emoji: string, at: number): void {
    const next = this.waitingList.filter((w) => !(w.to === peerId && w.id === id && w.e === emoji && w.at <= at));
    if (next.length !== this.waitingList.length) this.saveWaiting(next);
  }

  /** A friend removed: drop what waits for them (their file stays, like their messages). */
  forget(peerId: string): void {
    this.loaded.delete(peerId);
    const next = this.waitingList.filter((w) => w.to !== peerId);
    if (next.length !== this.waitingList.length) this.saveWaiting(next);
  }

  private get waitingFile(): string {
    return path.join(this.dir, 'dm-reactions.json');
  }

  private file(peerId: string): string {
    return path.join(this.dir, 'dms', `${safeName(peerId)}.reactions.jsonl`);
  }

  private take(peerId: string, event: ReactionEvent): boolean {
    const book = this.load(peerId);
    const next = applyReaction(book.get(event.id) ?? [], event);
    if (!next) return false;
    book.set(event.id, next);
    appendLine(this.file(peerId), lineOf(event));
    return true;
  }

  private load(peerId: string): Map<string, readonly ReactionEvent[]> {
    const known = this.loaded.get(peerId);
    if (known) return known;
    const lines = readLines(this.file(peerId));
    const byMessage = new Map<string, ReactionEvent[]>();
    for (const raw of lines) {
      const parsed = Line.safeParse(raw);
      if (parsed.success) byMessage.set(parsed.data.id, [...(byMessage.get(parsed.data.id) ?? []), eventOf(parsed.data)]);
    }
    const book = new Map([...byMessage.entries()].map(([id, events]) => [id, foldReactions(events)] as const));
    // Toggled back and forth a lot: the file is written again with only what counts.
    const kept = [...book.values()].reduce((n, list) => n + list.length, 0);
    if (lines.length > 4 * kept + 200) writeLines(this.file(peerId), [...book.values()].flat().map(lineOf));
    this.loaded.set(peerId, book);
    return book;
  }

  private saveWaiting(next: readonly WaitingReaction[]): void {
    this.waitingList = next;
    writeJson(this.waitingFile, next);
  }
}
