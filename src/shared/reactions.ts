import { z } from 'zod';

/**
 * Emoji reactions on chat messages (BLG-702), as Slack has them: under a message, a chip per emoji
 * with how many put it there, and who. Each person has at most one of each emoji on a message, and
 * a message at most MAX_DISTINCT different ones.
 *
 * What travels is one person's change at a time (`ReactionEvent`: this emoji on or off, at `at`).
 * The newest change per (message, emoji, person) wins, and an `off` wins a tie, so every Mac that
 * got the same changes, in any order, shows the same chips. Browser-safe (zod only): the daemon,
 * the Mac app and the views share it.
 */

/** The quick row before you have reactions of your own. */
export const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;
/** Emojis in the quick row. */
export const QUICK_COUNT = 6;
/** Different emojis on one message, at most. */
export const MAX_DISTINCT = 20;
/** The longest emoji (UTF-16 units): a family or a flag is several code points, as a status emoji. */
export const MAX_EMOJI = 32;

/** One emoji under a message, and who put it there (first first). */
export interface Reaction {
  readonly emoji: string;
  readonly by: readonly string[];
}

/** One person putting an emoji on a message (`on`) or taking it off. */
export interface ReactionEvent {
  /** The message. */
  readonly id: string;
  readonly emoji: string;
  readonly by: string;
  readonly on: boolean;
  /** Orders one person's changes to one emoji (ms since epoch, or a group log's position). */
  readonly at: number;
}

const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
/** Pictographs, flags, skin tones, joiners, keycaps (1️⃣) and a subdivision flag's tags: never a letter, a bare digit or a space. */
const EMOJI_ONLY = /^(?:[#*0-9]️?⃣|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[‍️]|[\u{e0020}-\u{e007f}])+$/u;

/** Is this one emoji-only string a reaction can be (no words, no spaces)? */
export const isEmoji = (text: string): boolean => text.length > 0 && text.length <= MAX_EMOJI && EMOJI_ONLY.test(text) && PICTURE.test(text);

export const EmojiSchema = z.string().min(1).max(MAX_EMOJI).refine(isEmoji, 'Not an emoji');

const key = (e: { readonly emoji: string; readonly by: string }): string => `${e.emoji}\u0000${e.by}`;

/** Does `next` replace `was` for the same (emoji, person)? Newer wins; on a tie, off wins. */
const beats = (next: ReactionEvent, was: ReactionEvent): boolean => next.at > was.at || (next.at === was.at && was.on && !next.on);

/**
 * One message's changes with `event` taken in: a new list when it changed anything, undefined when
 * it's older than what's there (or the same). A person keeps at most MAX_DISTINCT emojis on a
 * message: a new one past that replaces their oldest taken-off one, or is dropped.
 */
export function applyReaction(events: readonly ReactionEvent[], event: ReactionEvent): readonly ReactionEvent[] | undefined {
  const k = key(event);
  const at = events.findIndex((e) => key(e) === k);
  if (at >= 0) return beats(event, events[at]!) ? events.map((e, i) => (i === at ? event : e)) : undefined;
  const theirs = events.filter((e) => e.by === event.by);
  if (theirs.length < MAX_DISTINCT) return [...events, event];
  const off = theirs.filter((e) => !e.on).sort((a, b) => a.at - b.at)[0];
  return off ? [...events.filter((e) => e !== off), event] : undefined;
}

/** Many changes at once (a file read back, a log folded): in any order, the same result (below the per-person cap). */
export const foldReactions = (events: Iterable<ReactionEvent>, start: readonly ReactionEvent[] = []): readonly ReactionEvent[] => {
  let out = start;
  for (const e of events) out = applyReaction(out, e) ?? out;
  return out;
};

/**
 * The chips a message shows: each emoji someone has on it, in the order they were first put
 * there, with who (first first). At most MAX_DISTINCT; none: an empty list.
 */
export function reactionsOf(events: readonly ReactionEvent[]): Reaction[] {
  const on = events.filter((e) => e.on).sort((a, b) => a.at - b.at || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0));
  const by = new Map<string, string[]>();
  for (const e of on) by.set(e.emoji, [...(by.get(e.emoji) ?? []), e.by]);
  return [...by.entries()].slice(0, MAX_DISTINCT).map(([emoji, people]) => ({ emoji, by: people }));
}

/** Has `me` put this emoji on the message? */
export const hasReacted = (reactions: readonly Reaction[] | undefined, emoji: string, me: string): boolean => Boolean(reactions?.some((r) => r.emoji === emoji && r.by.includes(me)));

/**
 * Your change for a click on `emoji`: on when you hadn't put it there, off when you had (`on`
 * says which, when given). Refuses a new emoji on a message that has MAX_DISTINCT already.
 */
export function reactionChange(reactions: readonly Reaction[] | undefined, opts: { id: string; emoji: string; me: string; on?: boolean; at: number }): ReactionEvent {
  if (!isEmoji(opts.emoji)) throw new Error('That isn’t an emoji');
  const on = opts.on ?? !hasReacted(reactions, opts.emoji, opts.me);
  if (on && !reactions?.some((r) => r.emoji === opts.emoji) && (reactions?.length ?? 0) >= MAX_DISTINCT) throw new Error(`A message has at most ${MAX_DISTINCT} different reactions`);
  return { id: opts.id, emoji: opts.emoji, by: opts.me, on, at: opts.at };
}

/**
 * Your quick row: the emojis you react with most (in these messages), then the defaults, six in
 * all. Ties keep the defaults' order, then the order you first used them. `me`: your id, or your
 * ids (the room's and the network's).
 */
export function quickReactions(messages: Iterable<{ readonly reactions?: readonly Reaction[] }>, me: string | readonly string[], count = QUICK_COUNT): string[] {
  const ids = new Set(typeof me === 'string' ? [me] : me);
  const used = new Map<string, number>();
  for (const m of messages) for (const r of m.reactions ?? []) if (r.by.some((p) => ids.has(p))) used.set(r.emoji, (used.get(r.emoji) ?? 0) + 1);
  const rank = (e: string): number => {
    const d = (DEFAULT_REACTIONS as readonly string[]).indexOf(e);
    return d < 0 ? DEFAULT_REACTIONS.length : d;
  };
  const mine = [...used.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0])).map(([e]) => e);
  return [...new Set([...mine, ...DEFAULT_REACTIONS])].slice(0, count);
}

/** "kay, bob and 3 others" for a chip's tooltip (`nameOf` says "you" for you). */
export function reactorsLine(by: readonly string[], nameOf: (peerId: string) => string, shown = 3): string {
  const names = by.map(nameOf);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= shown) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const rest = names.length - shown;
  return `${names.slice(0, shown).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}
