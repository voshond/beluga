import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_REACTIONS,
  MAX_DISTINCT,
  type ReactionEvent,
  applyReaction,
  foldReactions,
  hasReacted,
  isEmoji,
  quickReactions,
  reactionChange,
  reactionsOf,
  reactorsLine,
} from '../src/shared/reactions.js';
import { DmReactions } from '../src/net/mesh/dm-reactions.js';
import { parseGroupReact, reactNote, splitReactions } from '../src/net/mesh/groups/reactions.js';
import type { ReadMessage } from '../src/net/mesh/groups/engine.js';
import type { Entry } from '../src/net/mesh/schemas.js';
import { initialNetwork, reduceNetwork } from '../src/core/network-store.js';
import { LinkMessage } from '../src/net/mesh/wire.js';
import { parseArgs } from '../src/ipc/api.js';
import type { MessageView } from '../src/net/mesh/views.js';

// Emoji reactions on chat messages (BLG-702): the model every Mac folds the same way.

const ev = (by: string, emoji: string, on: boolean, at: number, id = 'msg-000001'): ReactionEvent => ({ id, emoji, by, on, at });

describe('isEmoji', () => {
  it('takes single emojis, flags, skin tones, families and keycaps', () => {
    for (const e of ['👍', '❤️', '✅', '🇹🇷', '👍🏽', '👨‍👩‍👧', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🫠']) expect(isEmoji(e), e).toBe(true);
  });
  it('refuses words, spaces, bare digits, empty and over-long strings', () => {
    for (const e of ['', 'a', 'ok', '👍 ', ' 👍', '👍a', '1', '#', '<b>', '👍'.repeat(17)]) expect(isEmoji(e), JSON.stringify(e)).toBe(false);
  });
});

describe('applying changes', () => {
  it('counts each person once per emoji, and says who, first first', () => {
    const events = foldReactions([ev('ann', '👍', true, 1), ev('bob', '👍', true, 2), ev('ann', '👍', true, 3), ev('bob', '🎉', true, 4)]);
    expect(reactionsOf(events)).toEqual([
      { emoji: '👍', by: ['bob', 'ann'] },
      { emoji: '🎉', by: ['bob'] },
    ]);
  });

  it('toggles: a later off takes yours away, an older one changes nothing', () => {
    let events = foldReactions([ev('ann', '👍', true, 10)]);
    expect(applyReaction(events, ev('ann', '👍', false, 5))).toBeUndefined();
    events = applyReaction(events, ev('ann', '👍', false, 20))!;
    expect(reactionsOf(events)).toEqual([]);
    expect(applyReaction(events, ev('ann', '👍', false, 20))).toBeUndefined();
  });

  it('off wins a tie, so both orders agree', () => {
    const on = ev('ann', '👍', true, 7);
    const off = ev('ann', '👍', false, 7);
    expect(reactionsOf(foldReactions([on, off]))).toEqual([]);
    expect(reactionsOf(foldReactions([off, on]))).toEqual([]);
  });

  it('merges the same changes in any order to the same chips', () => {
    const all = [ev('ann', '👍', true, 1), ev('bob', '👍', true, 2), ev('ann', '👍', false, 3), ev('cat', '😂', true, 4), ev('ann', '😂', true, 5), ev('cat', '😂', false, 6), ev('bob', '👀', true, 7)];
    const expected = reactionsOf(foldReactions(all));
    const shuffles = [[...all].reverse(), [all[3]!, all[0]!, all[6]!, all[2]!, all[5]!, all[1]!, all[4]!], [all[6]!, all[5]!, all[4]!, all[0]!, all[1]!, all[2]!, all[3]!]];
    for (const order of shuffles) expect(reactionsOf(foldReactions(order))).toEqual(expected);
    expect(expected).toEqual([
      { emoji: '👍', by: ['bob'] },
      { emoji: '😂', by: ['ann'] },
      { emoji: '👀', by: ['bob'] },
    ]);
  });

  it('keeps at most MAX_DISTINCT emojis of one person, and shows at most MAX_DISTINCT chips', () => {
    const emojis = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋'];
    let events: readonly ReactionEvent[] = [];
    emojis.forEach((e, i) => (events = applyReaction(events, ev('ann', e, true, i)) ?? events));
    expect(events).toHaveLength(MAX_DISTINCT);
    // One taken off makes room for a new one.
    events = applyReaction(events, ev('ann', '😀', false, 100))!;
    events = applyReaction(events, ev('ann', '🥲', true, 101))!;
    expect(events.filter((e) => e.by === 'ann')).toHaveLength(MAX_DISTINCT);
    expect(reactionsOf(events).map((r) => r.emoji)).toContain('🥲');
    // Many people: never more than MAX_DISTINCT chips.
    const crowd = foldReactions(emojis.map((e, i) => ev(`p${i}`, e, true, i)));
    expect(reactionsOf(crowd)).toHaveLength(MAX_DISTINCT);
  });
});

describe('your change for a click', () => {
  const chips = [{ emoji: '👍', by: ['bob', 'me'] }];
  it('flips yours, or does what `on` says', () => {
    expect(reactionChange(chips, { id: 'm', emoji: '👍', me: 'me', at: 1 }).on).toBe(false);
    expect(reactionChange(chips, { id: 'm', emoji: '🎉', me: 'me', at: 1 }).on).toBe(true);
    expect(reactionChange(chips, { id: 'm', emoji: '👍', me: 'me', on: true, at: 1 }).on).toBe(true);
    expect(hasReacted(chips, '👍', 'me')).toBe(true);
    expect(hasReacted(chips, '👍', 'cat')).toBe(false);
  });
  it('refuses a non-emoji and a 21st different emoji (one already there is fine)', () => {
    expect(() => reactionChange([], { id: 'm', emoji: 'lol', me: 'me', at: 1 })).toThrow(/emoji/);
    const full = Array.from({ length: MAX_DISTINCT }, (_, i) => ({ emoji: String.fromCodePoint(0x1f600 + i), by: ['bob'] }));
    expect(() => reactionChange(full, { id: 'm', emoji: '🫠', me: 'me', at: 1 })).toThrow(/at most 20/);
    expect(reactionChange(full, { id: 'm', emoji: '😀', me: 'me', at: 1 }).on).toBe(true);
  });
});

describe('the quick row', () => {
  it('is the defaults until you have history, then your most used first', () => {
    expect(quickReactions([], 'me')).toEqual([...DEFAULT_REACTIONS]);
    const messages = [{ reactions: [{ emoji: '🚀', by: ['me'] }, { emoji: '👀', by: ['me', 'bob'] }] }, { reactions: [{ emoji: '🚀', by: ['me'] }] }, { reactions: [{ emoji: '🐳', by: ['bob'] }] }];
    expect(quickReactions(messages, 'me')).toEqual(['🚀', '👀', '👍', '❤️', '😂', '🎉']);
    expect(quickReactions(messages, 'me')).toHaveLength(6);
  });
  it('says who reacted in words', () => {
    const names: Record<string, string> = { a: 'you', b: 'bob', c: 'cat', d: 'dan', e: 'eve' };
    const nameOf = (p: string): string => names[p] ?? p;
    expect(reactorsLine(['b'], nameOf)).toBe('bob');
    expect(reactorsLine(['a', 'b'], nameOf)).toBe('you and bob');
    expect(reactorsLine(['a', 'b', 'c'], nameOf)).toBe('you, bob and cat');
    expect(reactorsLine(['a', 'b', 'c', 'd', 'e'], nameOf)).toBe('you, bob, cat and 2 others');
  });
});

describe('reactions in a direct conversation, on disk', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  it('keeps both sides’ reactions next to the messages, and yours wait until they arrive', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dm-reacts-'));
    dirs.push(dir);
    const book = new DmReactions(dir);
    expect(book.mine('pal', ev('me', '👍', true, 10))).toEqual([{ emoji: '👍', by: ['me'] }]);
    expect(book.theirs('pal', ev('pal', '👍', true, 11))).toBe(true);
    expect(book.theirs('pal', ev('pal', '👍', true, 9))).toBe(false);
    expect(book.waiting('pal')).toEqual([{ to: 'pal', id: 'msg-000001', e: '👍', on: true, at: 10 }]);
    // A newer change replaces what waits for the same emoji.
    book.mine('pal', ev('me', '👍', false, 12));
    expect(book.waiting('pal')).toHaveLength(1);
    book.delivered('pal', 'msg-000001', '👍', 10);
    expect(book.waiting('pal')).toHaveLength(1);
    expect(book.nextAt('pal', 'msg-000001', '👍', 'me')).toBeGreaterThan(12);

    const again = new DmReactions(dir);
    expect(again.of('pal', 'msg-000001')).toEqual([{ emoji: '👍', by: ['pal'] }]);
    expect(again.waiting('pal')).toEqual([{ to: 'pal', id: 'msg-000001', e: '👍', on: false, at: 12 }]);
    again.delivered('pal', 'msg-000001', '👍', 12);
    expect(new DmReactions(dir).waiting('pal')).toEqual([]);
    expect(readFileSync(path.join(dir, 'dms', 'pal.reactions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });
});

describe('reactions in a group log', () => {
  const entry = (id: string, author: string, lamport: number): Entry => ({ id: id.padEnd(64, '0'), group: 'g'.repeat(32), author, lamport, parents: [], type: 'message', ts: lamport, body: {}, sig: '' });
  it('takes them out of the messages and folds them in log order, ignoring ones to nothing', () => {
    const hello = entry('a', 'bob', 1);
    const read: ReadMessage[] = [
      { entry: hello, text: 'hello' },
      { entry: entry('b', 'ann', 2), text: reactNote('👍', true, 'hello'), react: { to: hello.id, e: '👍', on: true } },
      { entry: entry('c', 'cat', 3), text: '', react: { to: hello.id, e: '👍', on: true } },
      { entry: entry('d', 'ann', 4), text: '', react: { to: hello.id, e: '👍', on: false } },
      { entry: entry('e', 'ann', 5), text: '', react: { to: 'f'.repeat(64), e: '🎉', on: true } },
    ];
    const { messages, reactions } = splitReactions(read);
    expect(messages.map((m) => m.text)).toEqual(['hello']);
    expect(reactionsOf(reactions.get(hello.id) ?? [])).toEqual([{ emoji: '👍', by: ['cat'] }]);
    expect(reactions.has('f'.repeat(64))).toBe(false);
  });
  it('reads only well-formed reactions, and says them in words for older Macs', () => {
    expect(parseGroupReact({ text: '', react: { to: 'a'.repeat(64), e: '👍', on: true } })).toEqual({ to: 'a'.repeat(64), e: '👍', on: true });
    expect(parseGroupReact({ text: '', react: { to: 'a'.repeat(64), e: 'hi', on: true } })).toBeUndefined();
    expect(parseGroupReact({ text: '', react: { to: 'nope', e: '👍', on: true } })).toBeUndefined();
    expect(parseGroupReact({ text: 'plain' })).toBeUndefined();
    expect(reactNote('👍', true, 'Morning!   Staging is green')).toBe('Reacted 👍 to “Morning! Staging is green”');
    expect(reactNote('👍', false, '')).toBe('Took back 👍');
    expect(reactNote('🎉', true, 'x'.repeat(100))).toMatch(/^Reacted 🎉 to “x{59}…”$/);
  });
});

describe('the wire, the API and the shared state', () => {
  it('checks a reaction frame and the API arguments at the boundary', () => {
    expect(LinkMessage.safeParse({ t: 'dm_react', id: 'msg-000001', e: '👍', on: true, at: 1 }).success).toBe(true);
    expect(LinkMessage.safeParse({ t: 'dm_react', id: 'msg-000001', e: 'not an emoji', on: true, at: 1 }).success).toBe(false);
    expect(LinkMessage.safeParse({ t: 'dm_react', id: 'msg-000001', e: '👍'.repeat(20), on: true, at: 1 }).success).toBe(false);
    expect(LinkMessage.safeParse({ t: 'dm_react_ack', id: 'msg-000001', e: '👍', at: 1 }).success).toBe(true);
    const dm = `dm:${'a'.repeat(32)}`;
    expect(parseArgs('network.messages.react', [dm, 'msg-000001', '🎉'])).toEqual([dm, 'msg-000001', '🎉']);
    expect(parseArgs('network.messages.react', [dm, 'msg-000001', '🎉', false])).toEqual([dm, 'msg-000001', '🎉', false]);
    expect(() => parseArgs('network.messages.react', [dm, 'msg-000001', 'yes'])).toThrow();
    expect(() => parseArgs('network.messages.react', ['ws:1', 'msg-000001', '🎉'])).toThrow();
  });

  it('puts a message’s new chips in place, and takes them away when none are left', () => {
    const m: MessageView = { id: 'msg-000001', conversation: 'dm:x', from: 'bob', name: 'bob', text: 'hi', ts: 1, mine: false };
    let st = reduceNetwork(initialNetwork, { type: 'net_message', message: m });
    st = reduceNetwork(st, { type: 'net_reacted', conversation: 'dm:x', id: 'msg-000001', reactions: [{ emoji: '👍', by: ['me'] }] });
    expect(st.network.messages['dm:x']?.[0]?.reactions).toEqual([{ emoji: '👍', by: ['me'] }]);
    expect(reduceNetwork(st, { type: 'net_reacted', conversation: 'dm:x', id: 'older-000001', reactions: [] })).toBe(st);
    st = reduceNetwork(st, { type: 'net_reacted', conversation: 'dm:x', id: 'msg-000001', reactions: [] });
    expect(st.network.messages['dm:x']?.[0]).toEqual(m);
  });
});
