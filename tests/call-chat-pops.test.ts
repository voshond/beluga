import { describe, expect, it } from 'vitest';
import { netChat, roomChat } from '../packages/mac/src/call/call-chat.js';
import { type ChatPop, POPS_KEPT, POP_CHARS, PopClock, popMs, popText, popsNow } from '../packages/mac/src/call/chat-pops.js';
import { faceOrder, floatState } from '../packages/mac/src/call/float-model.js';
import type { LogItem } from '../src/core/store.js';
import type { MessageView } from '../src/net/mesh/views.js';
import type { CallView } from '../src/shared/calls.js';

/** The chat where it can't be seen during a call (BLG-717): the sharer's overlay, full screen, face to face. */

const pop = (id: string, text = 'hello', by = 'bob'): ChatPop => ({ id, by, name: by, text, at: 0 });
const msg = (id: string, extra: Partial<MessageView> = {}): MessageView => ({ id, conversation: 'group:g', from: 'bob', name: 'bob', text: `text ${id}`, ts: 1, mine: false, ...extra });

describe('what pops up', () => {
  it('stays long enough to read: longer for longer messages, within bounds', () => {
    expect(popMs('ok')).toBe(6_000);
    expect(popMs('word '.repeat(20))).toBeGreaterThan(popMs('a few words here'));
    expect(popMs('word '.repeat(500))).toBe(16_000);
  });

  it('is cut at a word when long, on one line', () => {
    expect(popText('two\n\nlines')).toBe('two lines');
    const long = popText('lorem ipsum '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(POP_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });

  it('never pops what was in the chat when it went out of sight; what comes after counts from when it came', () => {
    const clock = new PopClock([pop('old')]);
    const first = clock.stamp([pop('old'), pop('new')], 10_000);
    expect(popsNow(first, 10_000).map((p) => p.id)).toEqual(['new']);
    // A message's own time (another Mac's clock) doesn't matter: it came now.
    const later = clock.stamp([pop('old'), pop('new'), { ...pop('skewed'), at: -99_999 }], 12_000);
    expect(popsNow(later, 12_000).map((p) => p.id)).toEqual(['new', 'skewed']);
    // And it dissolves once there was time to read it.
    expect(popsNow(clock.stamp([pop('new')], 10_000 + popMs('hello')), 10_000 + popMs('hello'))).toEqual([]);
  });

  it('shows the newest few at once', () => {
    const clock = new PopClock([]);
    const many = Array.from({ length: 9 }, (_, i) => pop(`m${i}`));
    const shown = popsNow(clock.stamp(many, 1_000), 1_000);
    expect(shown).toHaveLength(POPS_KEPT);
    expect(shown.at(-1)?.id).toBe('m8');
  });
});

describe('a call’s chat, as it pops up', () => {
  it('leaves your own messages out but brings your agent’s answers in', () => {
    const got = netChat([msg('a'), msg('b', { mine: true }), msg('c', { mine: true, claude: { for: 'b' } }), msg('d', { claude: { for: 'x' } })]);
    expect(got.map((p) => [p.id, p.name, p.agent ?? false])).toEqual([
      ['a', 'bob', false],
      ['c', 'Your agent', true],
      ['d', 'bob’s agent', true],
    ]);
  });

  it('says a picture or a file was sent, and skips locked messages', () => {
    const got = netChat([
      msg('p', { text: '', files: [{ sha: 'x', name: 'a.png', size: 1, mime: 'image/png' }] }),
      msg('f', { text: '', files: [{ sha: 'y', name: 'a.zip', size: 1 }] }),
      msg('l', { status: 'locked' }),
    ]);
    expect(got.map((p) => p.text)).toEqual(['Sent a picture', 'Sent a file']);
  });

  it('reads the room’s chat from its log', () => {
    const chat = (id: string, from: string, byAgent = false, channel = 'room'): LogItem => ({ id, type: 'chat', channel, from, name: from, text: `hi ${id}`, ts: 1, byAgent });
    const log: LogItem[] = [chat('1', 'bob'), chat('2', 'me'), chat('3', 'me', true), chat('4', 'bob', false, 'ws:x')];
    expect(roomChat(log, 'me').map((p) => p.id)).toEqual(['1', '3']);
  });
});

describe('the floating card while you share', () => {
  it('says you share (and only then has Stop)', () => {
    const call = (sharing: boolean): CallView =>
      ({
        id: 'c',
        conversation: 'group:g',
        startedAt: 0,
        startedBy: 'me',
        mine: 'in',
        people: [
          { peerId: 'me', name: 'You', me: true, muted: false, sharing, joinedAt: 0 },
          { peerId: 'bob', name: 'bob', me: false, muted: false, sharing: false, joinedAt: 0 },
        ],
      }) as unknown as CallView;
    const on = floatState(call(true), [], new Set(), () => '#launch');
    const off = floatState(call(false), [], new Set(), () => '#launch');
    expect(on?.kind === 'in' && on.youShare).toBe(true);
    expect(off?.kind === 'in' && off.youShare).toBeFalsy();
  });
});

describe('the faces on the call card (BLG-743)', () => {
  const people = (ids: string, talking = '') => [...ids].map((id) => ({ peerId: id, speaking: talking.includes(id) }));

  it('starts in the call’s order', () => {
    expect(faceOrder([], people('abc'))).toEqual(['a', 'b', 'c']);
  });

  it('whoever talks moves to the front, and stays there once they stop, until someone else talks', () => {
    const one = faceOrder(['a', 'b', 'c'], people('abc', 'c'));
    expect(one).toEqual(['c', 'a', 'b']);
    expect(faceOrder(one, people('abc'))).toEqual(['c', 'a', 'b']);
    expect(faceOrder(one, people('abc', 'b'))).toEqual(['b', 'c', 'a']);
  });

  it('two talking at once keep their order between them, in front', () => {
    expect(faceOrder(['a', 'b', 'c'], people('abc', 'bc'))).toEqual(['b', 'c', 'a']);
  });

  it('someone who joins comes in at the end; someone who left goes', () => {
    expect(faceOrder(['a', 'b'], people('bd'))).toEqual(['b', 'd']);
  });
});
