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

const ws = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, projectId: 'p1', projectRoot: '/p', path: `/p/${id}`, kind: 'worktree', createdAt: 1000, ...extra });
const said = (id: string, channel: string, text: string, ts: number): LogItem => ({ id, type: 'chat', channel, from: ME, name: 'rob', text, ts, byAgent: false }) as LogItem;
const run = (id: string, channel: string, text: string, ts: number, extra: Record<string, unknown> = {}): LogItem =>
  ({ id, type: 'agent', channel, subagents: [], requestId: id, owner: ME, ownerName: 'rob', requesterName: 'rob', status: 'done', text, steps: [], ts, ...extra }) as LogItem;

const stateWith = (log: readonly LogItem[] = []): DomainState =>
  ({
    ...initialState('room'),
    selfId: ME,
    projectsLoaded: true,
    projects: [{ id: 'p1', name: 'Beluga', root: '/p', workspaces: [ws('main1', 'main', { kind: 'main' }), ws('wt-1', 'fix-tunnel'), ws('wt-2', 'old-work', { archived: true }), ws('wt-3', 'this-chat')] }],
    log,
  }) as unknown as DomainState;

type Hit = { ref: string; title?: string; state: string; pos: string; at: string; author: string; text: string; before?: string; after?: string };
type Answer = { query: string; hits: Hit[]; note?: string };

const tools = (state: DomainState, opts: { requester?: string; own?: string; sources?: () => readonly SearchSource[] } = {}) =>
  chatToolsOf({ state: () => state, requester: opts.requester ?? ME, chain: () => ({ chainId: 'c', hop: 0 }), ...(opts.own ? { own: opts.own } : {}), ...(opts.sources ? { sources: opts.sources } : {}) });

const answer = (text: string): Answer => {
  const inside = /<chat_data>\n([\s\S]*)\n<\/chat_data>/.exec(text)?.[1];
  if (inside === undefined) throw new Error(`no fence in: ${text}`);
  return JSON.parse(inside) as Answer;
};

const tunnel = [
  said('m1', 'ws:wt-1', 'the cloudflare tunnel keeps dropping', 1000),
  run('r1', 'ws:wt-1', 'Fixed the tunnel: the keepalive was 0, set it to 30s.', 2000),
  said('m2', 'ws:wt-1', 'thanks', 3000),
  said('m3', 'ws:wt-2', 'Tunnel works on the NAS too', 4000),
];

describe('search_chats', () => {
  it('finds past messages with every word, newest first, with the chat, when and the lines around', () => {
    const got = answer(tools(stateWith(tunnel)).search('tunnel', {}));
    expect(got.hits.map((h) => h.pos)).toEqual(['m3', 'r1', 'm1']);
    expect(got.hits[1]).toMatchObject({
      ref: `${ME}/ws:wt-1`,
      title: 'fix-tunnel',
      state: 'idle',
      pos: 'r1',
      at: new Date(2000).toISOString(),
      author: "rob's Claude",
      before: 'rob: the cloudflare tunnel keeps dropping',
      after: 'rob: thanks',
    });
    expect(got.hits[1]!.text).toContain('keepalive was 0');
    expect(got.hits[0]).toMatchObject({ title: 'old-work', state: 'archived' });
  });

  it('needs every word, in any case', () => {
    expect(answer(tools(stateWith(tunnel)).search('TUNNEL keepalive', {})).hits.map((h) => h.pos)).toEqual(['r1']);
  });

  it('says so when nothing matches', () => {
    const got = answer(tools(stateWith(tunnel)).search('kubernetes', {}));
    expect(got.hits).toEqual([]);
    expect(got.note).toMatch(/other words/);
  });

  it('leaves out the run’s own chat, the room and what has no address', () => {
    const log = [...tunnel, said('x1', 'ws:wt-3', 'how did we fix the tunnel', 5000), said('x2', 'room', 'tunnel in the room', 6000), said('x3', 'dm:abc', 'tunnel in a dm', 7000)];
    const pos = answer(tools(stateWith(log), { own: 'ws:wt-3' }).search('tunnel', {})).hits.map((h) => h.pos);
    expect(pos).toEqual(['m3', 'r1', 'm1']);
  });

  it('leaves out what read_chat does not show: notices and runs that never answered', () => {
    const log = [{ id: 's1', type: 'system', channel: 'ws:wt-1', text: 'tunnel notice', ts: 9000, level: 'info' } as LogItem, run('r9', 'ws:wt-1', 'tunnel half', 9500, { status: 'started' }), ...tunnel];
    expect(answer(tools(stateWith(log)).search('tunnel', {})).hits.map((h) => h.pos)).toEqual(['m3', 'r1', 'm1']);
  });

  it('reads saved and archived conversations it is given, not only the log', () => {
    const saved: SearchSource[] = [{ channel: 'ws:wt-2', place: 'old-work', items: [said('d1', 'ws:wt-2', 'tunnel from disk', 500)], archived: true }];
    expect(answer(tools(stateWith(), { sources: () => saved }).search('tunnel', {})).hits.map((h) => h.pos)).toEqual(['d1']);
  });

  it('redacts secrets in what it shows', () => {
    const log = [said('k1', 'ws:wt-1', 'tunnel token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and the file ~/.ssh/id_rsa', 1)];
    const hit = answer(tools(stateWith(log)).search('tunnel', {})).hits[0]!;
    expect(hit.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(hit.text).not.toContain('id_rsa');
  });

  describe('the cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => said(`n${i}`, 'ws:wt-1', `tunnel note ${i} ${'x'.repeat(2000)}`, i));

    it('gives 10 hits by default and never more than the most it allows', () => {
      expect(answer(tools(stateWith(many)).search('tunnel', {})).hits).toHaveLength(10);
      expect(answer(tools(stateWith(many)).search('tunnel', { limit: 500 })).hits.length).toBeLessThanOrEqual(MAX_SEARCH_HITS);
    });

    it('cuts each hit to an excerpt, and the answer to a size', () => {
      const text = tools(stateWith(many)).search('tunnel', { limit: MAX_SEARCH_HITS });
      for (const hit of answer(text).hits) expect(hit.text.length).toBeLessThan(400);
      expect(text.length).toBeLessThan(MAX_SEARCH_CHARS + 1000);
    });

    it('refuses a limit past the most through the tool', async () => {
      const client = new Client({ name: 'test', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await sdkServer(createChatTools(tools(stateWith(many)))).instance.connect(b);
      await client.connect(a);
      try {
        const got = await client.callTool({ name: 'search_chats', arguments: { query: 'tunnel', limit: MAX_SEARCH_HITS + 1 } });
        expect(got.isError).toBe(true);
        const listed = (await client.listTools()).tools.find((t) => t.name === 'search_chats');
        expect(listed?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
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
