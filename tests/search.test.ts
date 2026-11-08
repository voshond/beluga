import { describe, expect, it } from 'vitest';
import { searchConversations, snippet, type SearchSource } from '../src/core/search.js';
import type { LogItem } from '../src/core/store.js';

const chat = (id: string, name: string, text: string, ts: number): LogItem => ({ id, type: 'chat', channel: 'c', from: 'p', name, text, ts, byAgent: false });
const system = (id: string, text: string, ts: number): LogItem => ({ id, type: 'system', channel: 'c', text, ts, level: 'info' });
const agent = (id: string, ownerName: string, text: string, ts: number): LogItem => ({
  id,
  type: 'agent',
  channel: 'c',
  subagents: [],
  requestId: 'r',
  owner: 'o',
  ownerName,
  requesterName: 'kay',
  status: 'done',
  text,
  steps: [],
  ts,
});

const source = (items: LogItem[], extra: Partial<SearchSource> = {}): SearchSource => ({ channel: 'main', place: 'Chat', items, ...extra });

describe('searchConversations', () => {
  it('returns nothing for an empty or blank query', () => {
    const sources = [source([chat('1', 'bob', 'hello', 1)])];
    expect(searchConversations('', sources)).toEqual([]);
    expect(searchConversations('   \t ', sources)).toEqual([]);
  });

  it('requires every word to match, in any order and any case', () => {
    const sources = [source([chat('1', 'bob', 'The Auth middleware rejects tokens', 1), chat('2', 'bob', 'auth is fine', 2)])];
    expect(searchConversations('MIDDLEWARE auth', sources).map((h) => h.text)).toEqual(['The Auth middleware rejects tokens']);
    expect(searchConversations('auth', sources)).toHaveLength(2);
    expect(searchConversations('auth missing', sources)).toEqual([]);
  });

  it('matches words against the speaker name too', () => {
    const sources = [source([chat('1', 'Alice', 'deploy went out', 1), chat('2', 'bob', 'deploy failed', 2)])];
    const hits = searchConversations('alice deploy', sources);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ who: 'Alice', text: 'deploy went out', at: 0 });
  });

  it('uses at = 0 when the first word only matched the speaker', () => {
    const hits = searchConversations('alice deploy', [source([chat('1', 'Alice', 'we deploy now', 1)])]);
    expect(hits[0]!.at).toBe(0);
    const hits2 = searchConversations('deploy alice', [source([chat('1', 'Alice', 'we deploy now', 1)])]);
    expect(hits2[0]!.at).toBe(3);
  });

  it("labels agent replies as the owner's Claude and skips empty agent text", () => {
    const sources = [source([agent('1', 'bob', 'found the bug', 1), agent('2', 'bob', '', 2)])];
    expect(searchConversations("bob's", sources)).toEqual([{ channel: 'main', place: 'Chat', who: "bob's Claude", text: 'found the bug', at: 0, ts: 1, id: '1' }]);
    expect(searchConversations('claude', sources)).toHaveLength(1);
  });

  it('includes system lines with no speaker', () => {
    const hits = searchConversations('joined', [source([system('1', 'bob joined', 5)])]);
    expect(hits).toEqual([{ channel: 'main', place: 'Chat', who: '', text: 'bob joined', at: 4, ts: 5, id: '1' }]);
  });

  it('dates an earlier message of a shared chat by when it was said, as the chat draws it', () => {
    const said = { from: 'bob', name: 'bob', text: 'the old note', byAgent: false, ts: 3 };
    const earlier: LogItem = { id: '1', type: 'system', channel: 'c', text: 'bob: the old note', ts: 9, level: 'info', said };
    const hits = searchConversations('note', [source([earlier, system('2', 'note without a speaker', 8)])]);
    expect(hits.map((h) => h.ts)).toEqual([8, 3]);
  });

  it('gives the item id with every other field of the hit', () => {
    expect(searchConversations('hello', [source([chat('i9', 'bob', 'hello there', 7)], { archived: true })])).toEqual([{ channel: 'main', place: 'Chat', who: 'bob', text: 'hello there', at: 0, ts: 7, id: 'i9', archived: true }]);
  });

  it('leaves the id out for an item without one', () => {
    expect(searchConversations('hello', [source([chat('', 'bob', 'hello there', 7)])])[0]).not.toHaveProperty('id');
  });

  it('records where the first word starts (case-insensitive)', () => {
    const hits = searchConversations('rejects auth', [source([chat('1', 'b', 'The Auth middleware REJECTS', 1)])]);
    expect(hits[0]!.at).toBe('The Auth middleware '.length);
  });

  it('sorts newest first across sources and keeps channel/place', () => {
    const sources = [
      source([chat('1', 'b', 'ping one', 10), chat('2', 'b', 'ping three', 30)], { channel: 'a', place: 'api › add-auth' }),
      source([chat('3', 'b', 'ping two', 20)], { channel: 'g', place: 'the group chat' }),
    ];
    const hits = searchConversations('ping', sources);
    expect(hits.map((h) => [h.ts, h.channel, h.place])).toEqual([
      [30, 'a', 'api › add-auth'],
      [20, 'g', 'the group chat'],
      [10, 'a', 'api › add-auth'],
    ]);
  });

  it('marks hits from archived sources only', () => {
    const hits = searchConversations('x', [source([chat('1', 'b', 'x old', 1)], { archived: true }), source([chat('2', 'b', 'x new', 2)], { archived: false })]);
    expect(hits[0]).not.toHaveProperty('archived');
    expect(hits[1]).toMatchObject({ archived: true });
  });

  it('caps results at 200, keeping the newest', () => {
    const items = Array.from({ length: 250 }, (_, i) => chat(String(i), 'b', `match ${i}`, i));
    const hits = searchConversations('match', [source(items)]);
    expect(hits).toHaveLength(200);
    expect(hits[0]!.ts).toBe(249);
    expect(hits[199]!.ts).toBe(50);
  });
});

describe('snippet', () => {
  it('splits a short text around the match without ellipses', () => {
    const text = 'the auth middleware rejects';
    expect(snippet({ text, at: 4 }, 80)).toEqual({ before: 'the ', match: 'auth', after: ' middleware rejects' });
  });

  it('highlights the whole word starting at the match', () => {
    expect(snippet({ text: 'see middleware now', at: 4 }, 80).match).toBe('middleware');
  });

  it('adds leading and trailing ellipses when the text is cut', () => {
    const text = `${'a'.repeat(50)} needle ${'b'.repeat(50)}`;
    const s = snippet({ text, at: 51 }, 30);
    expect(s.match).toBe('needle');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.before.length - 1).toBe(10); // lead = floor(30 / 3)
    expect(s.after.endsWith('…')).toBe(true);
    expect((s.before + s.match + s.after).length).toBe(30 + 2);
  });

  it('has no leading ellipsis when the match is near the start', () => {
    const s = snippet({ text: `hi needle ${'z'.repeat(100)}`, at: 3 }, 30);
    expect(s.before).toBe('hi ');
    expect(s.after.endsWith('…')).toBe(true);
  });

  it('has no trailing ellipsis when the end is shown', () => {
    const s = snippet({ text: `${'z'.repeat(100)} needle`, at: 101 }, 30);
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.match).toBe('needle');
    expect(s.after).toBe('');
  });

  it('collapses whitespace and finds the match again in the flat text', () => {
    const text = 'line one\n\n   the\tauth   fails';
    const at = text.indexOf('auth');
    expect(snippet({ text, at }, 80)).toEqual({ before: 'line one the ', match: 'auth', after: ' fails' });
  });

  it('shows at least 10 characters for tiny widths', () => {
    const s = snippet({ text: 'abcdefghijklmnopqrstuvwxyz', at: 0 }, 2);
    expect(s.before).toBe('');
    expect(s.match).toBe('abcdefghij');
    expect(s.after).toBe('…');
  });

  it('copes with a match at whitespace and with negative widths', () => {
    expect(snippet({ text: '  hello', at: 0 }, 80)).toEqual({ before: '', match: '', after: ' hello' });
    expect(snippet({ text: 'hello world', at: 6 }, -5)).toEqual({ before: '…', match: 'world', after: '' });
  });

  it('works on hits returned by searchConversations', () => {
    const [hit] = searchConversations('bug', [source([chat('1', 'b', 'Found  the\nBUG here', 1)])]);
    expect(snippet(hit!, 80)).toEqual({ before: 'Found the ', match: 'BUG', after: ' here' });
  });
});
