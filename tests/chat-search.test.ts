import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createChatTools } from '../src/agent/chat-tools.js';
import { type PolicyContext, decideTool } from '../src/agent/policy.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import { sdkServer } from '../src/agent/runtime/claude/sdk-mount.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { MAX_SEARCH_CHARS, MAX_SEARCH_HITS, chatToolsOf } from '../src/core/chat-links/transcript.js';
import type { SearchSource } from '../src/core/search.js';
import { type DomainState, type LogItem, initialState } from '../src/core/store.js';
import { NOT_EXPOSED } from '../src/external/domain/tools.js';
import { humanizeTool } from '../src/shared/step-titles.js';

const ME = 'me-me-me-me-me-me-me-me-me-me-me0';
const FRIEND = 'friend-friend-friend-friend-frie';
const DAY = 86_400_000;

const ws = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, projectId: 'p1', projectRoot: '/p', path: `/p/${id}`, kind: 'worktree', createdAt: 1000, ...extra });
const said = (id: string, channel: string, text: string, ts: number): LogItem => ({ id, type: 'chat', channel, from: ME, name: 'rob', text, ts, byAgent: false }) as LogItem;
const run = (id: string, channel: string, text: string, ts: number, extra: Record<string, unknown> = {}): LogItem =>
  ({ id, type: 'agent', channel, subagents: [], requestId: id, owner: ME, ownerName: 'rob', requesterName: 'rob', status: 'done', text, steps: [], ts, ...extra }) as LogItem;

const stateWith = (log: readonly LogItem[] = [], more: ReadonlyArray<ReturnType<typeof ws>> = []): DomainState =>
  ({
    ...initialState('room'),
    selfId: ME,
    projectsLoaded: true,
    projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [ws('main1', 'main', { kind: 'main' }), ws('wt-1', 'fix-tunnel'), ws('wt-2', 'old-work', { archived: true }), ws('wt-3', 'this-chat'), ...more] }],
    log,
  }) as unknown as DomainState;

type Hit = { ref: string; title?: string; state: string; pos: string; at: string; author: string; text: string; before?: string[]; after?: string[]; more?: number; matched?: string[] };
type Answer = { query: string; order: string; loosened?: boolean; note?: string; hits: Hit[]; moreChats?: number };

const tools = (state: DomainState, opts: { requester?: string; own?: string; sources?: () => readonly SearchSource[] } = {}) =>
  chatToolsOf({ state: () => state, requester: opts.requester ?? ME, chain: () => ({ chainId: 'c', hop: 0 }), ...(opts.own ? { own: opts.own } : {}), ...(opts.sources ? { sources: opts.sources } : {}) });

const answer = (text: string): Answer => {
  const inside = /<chat_data>\n([\s\S]*)\n<\/chat_data>/.exec(text)?.[1];
  if (inside === undefined) throw new Error(`no fence in: ${text}`);
  return JSON.parse(inside) as Answer;
};
const positions = (text: string): string[] => answer(text).hits.map((h) => h.pos);

const tunnel = [
  said('m1', 'ws:wt-1', 'the cloudflare tunnel keeps dropping', 1000),
  run('r1', 'ws:wt-1', 'Fixed the tunnel: the keepalive was 0, set it to 30s.', 2000),
  said('m2', 'ws:wt-1', 'thanks', 3000),
  said('m3', 'ws:wt-2', 'Tunnel works on the NAS too', 4000),
];

describe('search_chats', () => {
  it('gives each chat’s best match, with when, who and the lines around it', () => {
    const got = answer(tools(stateWith(tunnel)).search('tunnel', {}));
    expect(got.hits.map((h) => h.pos)).toEqual(['r1', 'm3']);
    expect(got.hits[0]).toMatchObject({
      ref: `${ME}/ws:wt-1`,
      title: 'fix-tunnel',
      state: 'idle',
      pos: 'r1',
      at: new Date(2000).toISOString(),
      author: "rob's Claude",
      before: ['rob: the cloudflare tunnel keeps dropping'],
      after: ['rob: thanks'],
      more: 1,
    });
    expect(got.hits[0]!.text).toContain('keepalive was 0');
    expect(got.hits[1]).toMatchObject({ title: 'old-work', state: 'archived' });
    expect(got.hits[1]!.more).toBeUndefined();
  });

  it('needs every word, in any case, while some message has them all', () => {
    const got = answer(tools(stateWith(tunnel)).search('TUNNEL keepalive', {}));
    expect(got.hits.map((h) => h.pos)).toEqual(['r1']);
    expect(got.loosened).toBeUndefined();
  });

  it('counts a word in the chat’s title toward the words a hit covers', () => {
    expect(positions(tools(stateWith(tunnel)).search('tunnel thanks', {}))).toEqual(['m2']);
  });

  it('says how to broaden when nothing matches, and that nothing found is no proof', () => {
    const got = answer(tools(stateWith(tunnel)).search('kubernetes', {}));
    expect(got.hits).toEqual([]);
    expect(got.note).toMatch(/fewer words/);
    expect(got.note).toMatch(/not proof/);
  });

  it('leaves out the run’s own chat, the room and what has no address', () => {
    const log = [...tunnel, said('x1', 'ws:wt-3', 'how did we fix the tunnel', 5000), said('x2', 'room', 'tunnel in the room', 6000), said('x3', 'dm:abc', 'tunnel in a dm', 7000)];
    expect(positions(tools(stateWith(log), { own: 'ws:wt-3' }).search('tunnel', {}))).toEqual(['r1', 'm3']);
  });

  it('leaves out what read_chat does not show: notices and runs that never answered', () => {
    const log = [{ id: 's1', type: 'system', channel: 'ws:wt-2', text: 'tunnel notice', ts: 9000, level: 'info' } as LogItem, run('r9', 'ws:wt-2', 'tunnel half', 9500, { status: 'started' }), ...tunnel];
    expect(positions(tools(stateWith(log)).search('tunnel', {}))).toEqual(['r1', 'm3']);
  });

  it('reads saved and archived conversations it is given, not only the log', () => {
    const saved: SearchSource[] = [{ channel: 'ws:wt-2', place: 'old-work', items: [said('d1', 'ws:wt-2', 'tunnel from disk', 500)], archived: true }];
    expect(positions(tools(stateWith(), { sources: () => saved }).search('tunnel', {}))).toEqual(['d1']);
  });

  it('redacts secrets in what it shows', () => {
    const log = [said('k1', 'ws:wt-1', 'tunnel token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and the file ~/.ssh/id_rsa', 1)];
    const hit = answer(tools(stateWith(log)).search('tunnel', {})).hits[0]!;
    expect(hit.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(hit.text).not.toContain('id_rsa');
  });

  it('finds a match past the first 4,000 characters of a long message', () => {
    const log = [said('long', 'ws:wt-2', `${'filler '.repeat(1000)} the needle is here`, 1)];
    expect(answer(tools(stateWith(log)).search('needle', {})).hits[0]!.text).toContain('needle');
  });

  it('filters before the cap: a crowded room and DMs never push out a hit it may read', () => {
    const crowd = Array.from({ length: 400 }, (_, i) => said(`c${i}`, i % 2 ? 'room' : 'dm:abc', `tunnel chatter ${i}`, 10_000 + i));
    const log = [said('old', 'ws:wt-2', 'the tunnel fix from long ago', 1), ...crowd];
    expect(positions(tools(stateWith(log)).search('tunnel', {}))).toEqual(['old']);
  });

  it('gives one hit for a chat with many matches, and says how many more it has', () => {
    const many = Array.from({ length: 30 }, (_, i) => said(`n${i}`, 'ws:wt-1', `tunnel note ${i}`, 100 + i));
    const got = answer(tools(stateWith([...many, said('m3', 'ws:wt-2', 'tunnel elsewhere', 1)])).search('tunnel', {}));
    expect(got.hits.map((h) => h.pos)).toEqual(['n29', 'm3']);
    expect(got.hits[0]!.more).toBe(29);
  });

  describe('ranking', () => {
    const log = [said('both', 'ws:wt-2', 'the deploy broke the cache', 1000), said('one', 'ws:wt-3', 'the deploy went fine', 9000), said('first', 'ws:chat-x', 'deploy plan drafted', 500)];
    const state = () => stateWith(log, [ws('chat-x', 'notes', { kind: 'chat' })]);

    it('puts the hit covering more words first, newer ones first at the same coverage', () => {
      expect(positions(tools(state()).search('deploy cache', {}))).toEqual(['both']);
      expect(positions(tools(state()).search('deploy', {}))).toEqual(['one', 'both', 'first']);
    });

    it('prefers a match in the chat’s title at the same coverage', () => {
      const titled = [said('t1', 'ws:wt-1', 'tunnel', 1), said('t2', 'ws:wt-2', 'tunnel', 99)];
      expect(positions(tools(stateWith(titled)).search('tunnel', {}))).toEqual(['t1', 't2']);
    });

    it('takes newest or oldest first when asked', () => {
      expect(positions(tools(state()).search('deploy', { order: 'newest' }))).toEqual(['one', 'both', 'first']);
      expect(positions(tools(state()).search('deploy', { order: 'oldest' }))).toEqual(['first', 'both', 'one']);
      expect(answer(tools(state()).search('deploy', { order: 'oldest' })).order).toBe('oldest');
    });
  });

  describe('the loosened retry', () => {
    const log = [said('a', 'ws:wt-2', 'the deploy broke the cache', 1000), said('b', 'ws:wt-3', 'cache only', 9000)];

    it('when no message has every word, finds any of them, most words first, and says so', () => {
      const got = answer(tools(stateWith(log)).search('deploy cache redis', {}));
      expect(got.loosened).toBe(true);
      expect(got.note).toMatch(/loosened/);
      expect(got.hits.map((h) => [h.pos, h.matched])).toEqual([
        ['a', ['deploy', 'cache']],
        ['b', ['cache']],
      ]);
    });

    it('stays exact when some message has every word', () => {
      const got = answer(tools(stateWith(log)).search('deploy cache', {}));
      expect(got.loosened).toBeUndefined();
      expect(got.hits.map((h) => h.pos)).toEqual(['a']);
      expect(got.hits[0]!.matched).toBeUndefined();
    });
  });

  describe('time bounds', () => {
    const now = Date.now();
    const log = [said('old', 'ws:wt-2', 'tunnel then', now - 30 * DAY), said('new', 'ws:wt-3', 'tunnel now', now - DAY)];

    it('takes a span back from now', () => {
      expect(positions(tools(stateWith(log)).search('tunnel', { after: '7d' }))).toEqual(['new']);
      expect(positions(tools(stateWith(log)).search('tunnel', { before: '2w' }))).toEqual(['old']);
    });

    it('takes an ISO date', () => {
      expect(positions(tools(stateWith(log)).search('tunnel', { before: new Date(now - 7 * DAY).toISOString() }))).toEqual(['old']);
    });

    it('refuses what is not a time', () => {
      expect(() => tools(stateWith(log)).search('tunnel', { after: 'last week' })).toThrow(/^bad_time/);
    });
  });

  describe('the cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => said(`n${i}`, `ws:c${i}`, `tunnel note ${i} ${'x'.repeat(2000)}`, i));
    const crowded = () => stateWith(many, many.map((_, i) => ws(`c${i}`, `chat ${i}`, { kind: 'chat' })));

    it('gives 10 chats by default and never more than the most it allows', () => {
      const got = answer(tools(crowded()).search('tunnel', {}));
      expect(got.hits).toHaveLength(10);
      expect(got.moreChats).toBe(50);
      expect(answer(tools(crowded()).search('tunnel', { limit: 500 })).hits.length).toBeLessThanOrEqual(MAX_SEARCH_HITS);
    });

    it('cuts each hit to an excerpt, wider for the top one, and the answer to a size', () => {
      const text = tools(crowded()).search('tunnel', { limit: MAX_SEARCH_HITS });
      const [top, ...rest] = answer(text).hits;
      expect(top!.text.length).toBeLessThan(700);
      expect(top!.text.length).toBeGreaterThan(rest[0]!.text.length);
      for (const hit of rest) expect(hit.text.length).toBeLessThan(300);
      expect(text.length).toBeLessThan(MAX_SEARCH_CHARS + 1000);
    });

    it('refuses a limit past the most through the tool, and says an empty search proves nothing', async () => {
      const client = new Client({ name: 'test', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await sdkServer(createChatTools(tools(crowded()))).instance.connect(b);
      await client.connect(a);
      try {
        const got = await client.callTool({ name: 'search_chats', arguments: { query: 'tunnel', limit: MAX_SEARCH_HITS + 1 } });
        expect(got.isError).toBe(true);
        const listed = (await client.listTools()).tools.find((t) => t.name === 'search_chats');
        expect(listed?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
        expect(listed?.description).toMatch(/not proof/);
      } finally {
        await client.close();
      }
    });
  });

  it('a hit opens with read_chat, around its pos', () => {
    const t = tools(stateWith(tunnel));
    const hit = answer(t.search('keepalive', {})).hits[0]!;
    const page = answer(t.read(hit.ref, { around: hit.pos, limit: 3 })) as unknown as { items: Array<{ pos: string }> };
    expect(page.items.map((i) => i.pos)).toEqual(['m1', 'r1', 'm2']);
    expect(() => t.read(hit.ref, { around: 'nope' })).toThrow(/^bad_position/);
  });

  it('gives a run from someone else nothing', () => {
    expect(answer(tools(stateWith(tunnel), { requester: FRIEND }).search('tunnel', {})).hits).toEqual([]);
  });
});

describe('search_chats everywhere else', () => {
  const ctx: PolicyContext = { cwd: '/tmp', roots: ['/tmp'], autoEdit: false, scope: 'folder' };

  it('never asks: only your own runs have it, and it only reads', () => {
    expect(decideTool('mcp__beluga_chats__search_chats', {}, ctx)).toBe('allow');
  });

  it('is never offered to external agents', () => {
    expect(NOT_EXPOSED.search_chats).toBe('chat_only');
  });

  it('reads as words', () => {
    expect(humanizeTool('mcp__beluga_chats__search_chats', { query: 'tunnel' }).done).toBe('Searched past chats for “tunnel”');
  });

  it('the run’s instructions say when to use it, only for runs that have it', () => {
    const input = { prompt: 'hi', requesterName: 'rob', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true } as AgentRunInput;
    expect(runInstructions({ ...input, chatTools: tools(stateWith()) }, 'rob')).toMatch(/search_chats[\s\S]*how did we fix/);
    expect(runInstructions(input, 'rob')).not.toContain('search_chats');
  });
});
