/**
 * Ranking for search_chats (BLG-99), with no index: the best match in each chat, ranked by how
 * many of the query's words it covers (a word in the chat's title counts), then a title match,
 * then the newest. When no message has every word, it tries again with any of them, and says so.
 */

export type RecallOrder = 'relevance' | 'newest' | 'oldest';

export interface RecallMessage {
  readonly ts: number;
  readonly author: string;
  readonly text: string;
}

export interface RecallChat {
  readonly key: string;
  readonly title: string;
  readonly messages: readonly RecallMessage[];
}

export interface RecallMatch {
  readonly key: string;
  /** The message in its chat's `messages`. */
  readonly index: number;
  readonly ts: number;
  /** The query's words it covers, in the query's order. */
  readonly matched: readonly string[];
  /** How many of the query's words the chat's title has. */
  readonly inTitle: number;
  /** The chat's other messages that match too. */
  readonly more: number;
}

export interface RecallOptions {
  readonly order?: RecallOrder;
  /** Only messages at or after this time (ms). */
  readonly after?: number;
  /** Only messages before this time (ms). */
  readonly before?: number;
}

export interface Recall {
  readonly matches: readonly RecallMatch[];
  /** No message had every word: these have some of them. */
  readonly loosened: boolean;
}

const SPANS: Readonly<Record<string, number>> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export const queryWords = (query: string): string[] => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];

export function recall(chats: readonly RecallChat[], query: string, opts: RecallOptions = {}): Recall {
  const words = queryWords(query);
  if (!words.length) return { matches: [], loosened: false };
  const every = bestPerChat(chats, words, 'all', opts);
  if (every.length || words.length === 1) return { matches: every, loosened: false };
  return { matches: bestPerChat(chats, words, 'any', opts), loosened: true };
}

/** A time bound as an ISO date or a span back from now: 24h, 7d, 2w. Throws on anything else. */
export function timeBound(text: string, now: number): number {
  const span = /^(\d+)\s*([hdw])$/i.exec(text.trim());
  if (span) return now - Number(span[1]) * SPANS[span[2]!.toLowerCase()]!;
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`bad_time: "${text}" is not a date. Give an ISO date (2026-11-01) or a span back from now (24h, 7d, 2w).`);
  return at;
}

function bestPerChat(chats: readonly RecallChat[], words: readonly string[], mode: 'all' | 'any', opts: RecallOptions): RecallMatch[] {
  const order = opts.order ?? 'relevance';
  const found: RecallMatch[] = [];
  for (const chat of chats) {
    const title = chat.title.toLowerCase();
    const titled = words.filter((w) => title.includes(w));
    let best: Omit<RecallMatch, 'more'> | undefined;
    let count = 0;
    chat.messages.forEach((m, index) => {
      if ((opts.after !== undefined && m.ts < opts.after) || (opts.before !== undefined && m.ts >= opts.before)) return;
      const said = `${m.text}\n${m.author}`.toLowerCase();
      const inMessage = words.filter((w) => said.includes(w));
      if (!inMessage.length) return;
      const matched = words.filter((w) => inMessage.includes(w) || titled.includes(w));
      if (mode === 'all' && matched.length < words.length) return;
      count++;
      const hit = { key: chat.key, index, ts: m.ts, matched, inTitle: titled.length };
      if (!best || compare(hit, best, order) < 0) best = hit;
    });
    if (best) found.push({ ...best, more: count - 1 });
  }
  return found.sort((a, b) => compare(a, b, order));
}

const compare = (a: Omit<RecallMatch, 'more'>, b: Omit<RecallMatch, 'more'>, order: RecallOrder): number => {
  if (order === 'newest') return b.ts - a.ts;
  if (order === 'oldest') return a.ts - b.ts;
  return b.matched.length - a.matched.length || b.inTitle - a.inTitle || b.ts - a.ts;
};
