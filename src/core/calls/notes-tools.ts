import { clockOf, findTurns, lengthOf, turns, wordCount } from '../../shared/call-notes.js';
import type { CallNotesView } from '../../shared/calls.js';
import type { CallNotesTools } from '../../agent/types.js';

/**
 * Call notes as an agent reads them (BLG-715): never pasted into a prompt, looked up as needed.
 * The agent lists the calls, searches what was said, and reads a part of one a page at a time,
 * the way you'd skim a long transcript. `scope`: only one conversation's calls (an agent answering
 * in a chat sees that chat's calls and no others).
 */

/** Turns on one page of read_call. */
const PAGE = 40;
/** Hits one search gives back. */
const HITS = 25;
/** How much of a turn a search hit shows around the words found. */
const SNIPPET = 220;

export interface NotesSource {
  /** Every call's notes, by conversation (oldest first in each). */
  readonly views: () => Readonly<Record<string, readonly CallNotesView[]>>;
  /** A conversation's name for people ("#launch", "a DM with bob", "the room"). */
  readonly placeOf: (conversation: string) => string;
}

const dayTime = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

function snippet(text: string, query: string): string {
  if (text.length <= SNIPPET) return text;
  const first = query.toLowerCase().split(/\s+/).find(Boolean);
  const at = first ? text.toLowerCase().indexOf(first) : 0;
  const from = Math.max(0, at - SNIPPET / 3);
  return `${from > 0 ? '…' : ''}${text.slice(from, from + SNIPPET)}${from + SNIPPET < text.length ? '…' : ''}`;
}

/** "12:30" or "1:02:00" into the call → ms; a number is minutes. */
function offsetOf(at: string | number | undefined): number | undefined {
  if (at === undefined) return undefined;
  if (typeof at === 'number') return at * 60_000;
  const parts = at.split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts.reduce((s, n) => s * 60 + n, 0) * 1000;
}

export function callNotesTools(src: NotesSource, scope?: string): CallNotesTools {
  const calls = (): CallNotesView[] =>
    Object.entries(src.views())
      .filter(([c]) => !scope || c === scope)
      .flatMap(([, list]) => list)
      .sort((a, b) => b.endedAt - a.endedAt);
  const need = (id: string): CallNotesView => {
    const v = calls().find((c) => c.id === id || c.id.startsWith(id));
    if (!v) throw new Error(`No call ${id} here. call_notes_list shows the calls you can read.`);
    return v;
  };
  return {
    list: (limit = 20) => {
      const all = calls().slice(0, Math.min(Math.max(limit, 1), 100));
      if (!all.length) return scope ? 'No calls in this chat have notes yet.' : 'No calls have notes yet.';
      return all
        .map((v) => {
          const waiting = v.people.filter((p) => !p.sent && p.name !== 'You').map((p) => p.name);
          return `- ${v.id} · ${src.placeOf(v.conversation)} · ${dayTime(v.startedAt)} UTC · ${lengthOf(v)} · with ${v.people.map((p) => p.name).join(', ')} · ${wordCount(v.lines)} words${waiting.length ? ` (still waiting for ${waiting.join(', ')}'s part)` : ''}`;
        })
        .join('\n');
    },
    search: (query, call, limit = HITS) => {
      const pool = call ? [need(call)] : calls();
      const hits = pool.flatMap((v) => {
        const all = turns(v.lines);
        return findTurns(all, query).map((i) => ({ v, t: all[i]! }));
      });
      if (!hits.length) return `Nothing said matches “${query}”${call ? ' in that call' : ''}. Try fewer or other words, or read the call with call_notes_read.`;
      const shown = hits.slice(0, Math.min(Math.max(limit, 1), 100));
      return [
        `${hits.length} place${hits.length === 1 ? '' : 's'} match “${query}”${hits.length > shown.length ? ` (the first ${shown.length})` : ''}:`,
        ...shown.map(({ v, t }) => `- call ${v.id} at ${clockOf(v.startedAt, t.at)}, ${t.name}: ${snippet(t.text, query)}`),
        'Read around one with call_notes_read(call, at: "12:30").',
      ].join('\n');
    },
    read: (call, opts = {}) => {
      const v = need(call);
      const all = turns(v.lines);
      if (!all.length) return 'Nothing was written down in that call.';
      const limit = Math.min(Math.max(opts.limit ?? PAGE, 1), 200);
      const offset = offsetOf(opts.at);
      // From a time into the call (a little before it, for context), or from a turn number.
      let from = opts.from ?? 0;
      if (offset !== undefined) {
        const i = all.findIndex((t) => t.at - v.startedAt >= offset);
        from = Math.max(0, (i < 0 ? all.length - 1 : i) - 3);
      }
      from = Math.min(Math.max(0, from), all.length - 1);
      const page = all.slice(from, from + limit);
      const next = from + page.length < all.length ? from + page.length : undefined;
      return [
        `Call ${v.id} · ${src.placeOf(v.conversation)} · ${lengthOf(v)} · turns ${from + 1}–${from + page.length} of ${all.length}:`,
        ...page.map((t) => `[${clockOf(v.startedAt, t.at)}] ${t.name}: ${t.text}`),
        next !== undefined ? `More: call_notes_read(call: "${v.id}", from: ${next}).` : '(the end of the call)',
      ].join('\n');
    },
  };
}

/** What an agent asked in a chat is told about its calls: that they exist, and how to look. Never what was said. */
export function notesHint(src: NotesSource, conversation: string): string | undefined {
  const list = src.views()[conversation];
  const last = list?.at(-1);
  if (!list?.length || !last) return undefined;
  return `This chat has notes of ${list.length === 1 ? 'a call' : `${list.length} calls`} (the latest: ${dayTime(last.startedAt)} UTC, ${lengthOf(last)}, with ${last.people.map((p) => p.name).join(', ')}). They aren't in this prompt. When the message is about something said in a call, look it up: call_notes_search for words, call_notes_read for a part of a call, call_notes_list for the calls.`;
}
