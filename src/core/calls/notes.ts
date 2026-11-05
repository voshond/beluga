import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CallNotesView, NotesLine } from '../../shared/calls.js';
import { NotePhrases, type PastCall } from './service.js';

/**
 * Call notes (BLG-715). Nobody records anyone else: each Mac writes down only its own microphone,
 * on its own GPU, and as it leaves the call it sends its words to the others who were in it. This
 * keeps every part it has, one file per call (`~/.beluga/call-notes/<call>.json`, only you can
 * read it), and merges them into one transcript in the order things were said.
 */

const Saved = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  conversation: z.string().max(80),
  startedAt: z.number(),
  endedAt: z.number(),
  people: z.record(z.string(), z.string().max(80)),
  parts: z.record(z.string(), NotePhrases),
});
type Saved = z.infer<typeof Saved>;

/** Notes kept per conversation in the shared state (older ones stay on disk). */
const VIEWS_PER_CONVERSATION = 12;

export interface CallNotesHost {
  /** Where the notes live; null: memory only (the demo, tests). */
  readonly dir: string | null;
  /** Whether a peer id is you (your friends' links and a room know you by different ids). */
  readonly isMe: (peerId: string) => boolean;
  readonly nameOf: (peerId: string) => string;
  readonly publish: (notes: Readonly<Record<string, readonly CallNotesView[]>>) => void;
}

export class CallNotes {
  private readonly calls = new Map<string, Saved>();

  constructor(private readonly host: CallNotesHost) {
    if (!host.dir) return;
    try {
      for (const f of readdirSync(host.dir)) {
        if (!f.endsWith('.json')) continue;
        const parsed = Saved.safeParse(JSON.parse(readFileSync(path.join(host.dir, f), 'utf8')));
        if (parsed.success) this.calls.set(parsed.data.id, parsed.data);
      }
    } catch {
      // No notes yet.
    }
  }

  /** Your own words in a call (from your window, as you leave it); `self`: your id where the call was. */
  mine(self: string, call: PastCall, phrases: NotePhrases): void {
    this.add(self, call, phrases);
  }

  /** Someone else's words in a call you were in (the call service checked they were). */
  theirs(from: string, call: PastCall, phrases: NotePhrases): void {
    this.add(from, call, phrases);
  }

  /** Forget a call's notes on this Mac (the others keep theirs). */
  forget(id: string): void {
    if (!this.calls.delete(id)) return;
    if (this.host.dir) rmSync(path.join(this.host.dir, `${id}.json`), { force: true });
    this.publish();
  }

  views(): Record<string, CallNotesView[]> {
    const by: Record<string, CallNotesView[]> = {};
    for (const c of [...this.calls.values()].sort((a, b) => a.endedAt - b.endedAt)) (by[c.conversation] ??= []).push(this.view(c));
    for (const k of Object.keys(by)) by[k] = by[k]!.slice(-VIEWS_PER_CONVERSATION);
    return by;
  }

  private add(peerId: string, call: PastCall, phrases: NotePhrases): void {
    const was = this.calls.get(call.id);
    const people = { ...was?.people, ...Object.fromEntries([...call.people].map((p) => [p, this.host.isMe(p) ? 'You' : this.host.nameOf(p)])) };
    // It ended when you last saw it going (or when the last thing was said, if later).
    const endedAt = Math.max(was?.endedAt ?? call.startedAt, call.lastSeen, phrases.at(-1)?.at ?? 0);
    const saved: Saved = { id: call.id, conversation: call.conversation, startedAt: call.startedAt, endedAt, people, parts: { ...was?.parts, [peerId]: phrases } };
    this.calls.set(call.id, saved);
    if (this.host.dir) {
      mkdirSync(this.host.dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(this.host.dir, `${call.id}.json`), JSON.stringify(saved), { mode: 0o600 });
    }
    this.publish();
  }

  private view(c: Saved): CallNotesView {
    const lines: NotesLine[] = Object.entries(c.parts)
      .flatMap(([by, phrases]) => phrases.map((p) => ({ by, name: c.people[by] ?? this.host.nameOf(by), at: p.at, text: p.text })))
      .sort((a, b) => a.at - b.at);
    return { id: c.id, conversation: c.conversation, startedAt: c.startedAt, endedAt: c.endedAt, people: Object.entries(c.people).map(([peerId, name]) => ({ peerId, name, sent: peerId in c.parts })), lines };
  }

  private publish(): void {
    this.host.publish(this.views());
  }
}
