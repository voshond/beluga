import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HonchoClient, HonchoError, type HonchoFetch } from '../src/core/honcho/client.js';
import { loadHonchoConfig } from '../src/core/honcho/config.js';
import { HonchoFeed } from '../src/core/honcho/feed.js';
import { type FilterContext, type Outgoing, cleanText, conversationOf, pickOutgoing } from '../src/core/honcho/filter.js';
import { HONCHO_USER_PEER, agentPeerId, honchoId, sessionIdOf } from '../src/core/honcho/mapping.js';
import { HonchoQueue } from '../src/core/honcho/queue.js';
import { type Action, Store, initialState } from '../src/core/store.js';
import { parseArgs } from '../src/ipc/api.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const SELF = 'me';
const FRIEND = 'friend';
const NOW = new Date(2026, 10, 18, 12).getTime();
const KEY = 'hch-test-key-0123456789';

const ws = (id: string, more: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p1', projectRoot: '/code/app', name: `task ${id}`, path: `/wt/${id}`, kind: 'worktree', branch: `beluga/${id}`, createdAt: NOW, external: false, ...more });
const project = (id: string, workspaces: Workspace[]): Project => ({ id, name: `project ${id}`, root: `/code/${id}`, base: 'origin/main', workspaces });

const storeWith = (): Store => {
  const store = new Store(initialState('test', 'ask'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
  store.dispatch({ type: 'projects', projects: [project('p1', [ws('a'), ws('t', { thread: { parent: 'a' } as Workspace['thread'] }), ws('shared')]), project('p2', [ws('b', { projectId: 'p2' })])] });
  return store;
};

const ctxOf = (store: Store, more: Partial<FilterContext> = {}): FilterContext => ({ state: store.getState(), excluded: [], since: 0, sharedWith: (c) => c === 'ws:shared', ...more });

const mine = (text: string, more: Partial<Extract<Action, { type: 'chat' }>> = {}): Action => ({ type: 'chat', id: `m-${text}`, from: SELF, text, ts: NOW, byAgent: false, channel: 'ws:a', ...more });
const answer = (text: string, more: Partial<Extract<Action, { type: 'agent_event' }>> = {}): Action => ({ type: 'agent_event', owner: SELF, requestId: `r-${text}`, requester: SELF, event: 'done', text, ts: NOW, channel: 'ws:a', ...more });

type Call = { readonly url: string; readonly auth?: string; readonly body: Record<string, unknown> };

const fakeFetch = (answer: (url: string) => number = () => 200): { fetch: HonchoFetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetch: HonchoFetch = async (url, init) => {
    calls.push({ url, ...(init.headers.authorization ? { auth: init.headers.authorization } : {}), body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
    const status = answer(url);
    return { ok: status < 300, status, text: async () => '' };
  };
  return { fetch, calls };
};

const item = (id: string, session = 's1'): Outgoing => ({ id, conversation: { channel: `ws:${session}`, session, kind: 'worktree' }, peer: { id: HONCHO_USER_PEER, role: 'user' }, content: id, ts: NOW, metadata: { kind: 'user' } });

describe('the mapping', () => {
  it('makes ids Honcho accepts', () => {
    expect(honchoId('ws:abc/def')).toBe('ws_abc_def');
    expect(honchoId('')).toBe('_');
    expect(honchoId('x'.repeat(600))).toHaveLength(512);
    expect(sessionIdOf('ws:abc')).toBe('beluga-ws_abc');
    expect(sessionIdOf('mac:assistant:2')).toBe('beluga-mac_assistant_2');
  });

  it('gives the user one peer and each agent runtime its own', () => {
    expect(HONCHO_USER_PEER).toBe('user');
    expect(agentPeerId('codex')).toBe('agent-codex');
    expect(agentPeerId('')).toBe('agent-claude');
  });

  it('maps a conversation to its project and kind', () => {
    const store = storeWith();
    expect(conversationOf(store.getState(), 'ws:a')).toMatchObject({ session: 'beluga-ws_a', kind: 'worktree', projectId: 'p1', projectName: 'project p1', title: 'task a' });
    expect(conversationOf(store.getState(), 'mac:assistant')).toMatchObject({ kind: 'your-mac' });
    expect(conversationOf(store.getState(), 'ws:t')).toBeUndefined();
    expect(conversationOf(store.getState(), 'ws:nowhere')).toBeUndefined();
    expect(conversationOf(store.getState(), 'room')).toBeUndefined();
  });
});

describe('the filter', () => {
  it('takes your own messages and your own agents’ answers', () => {
    const store = storeWith();
    expect(pickOutgoing(mine('fix the login'), ctxOf(store))).toMatchObject({ peer: { id: 'user', role: 'user' }, content: 'fix the login', conversation: { session: 'beluga-ws_a' } });
    expect(pickOutgoing(answer('done, the cookie was stale', { agent: { runtime: 'codex', label: 'Codex', model: 'gpt-5' } }), ctxOf(store))).toMatchObject({ peer: { id: 'agent-codex', role: 'agent' }, metadata: { runtime: 'codex', model: 'gpt-5' } });
    expect(pickOutgoing(mine('hi', { channel: 'mac:assistant' }), ctxOf(store))).toMatchObject({ conversation: { kind: 'your-mac' } });
  });

  it('leaves out friends, runs for friends, agents writing for you and shared chats', () => {
    const store = storeWith();
    const ctx = ctxOf(store);
    expect(pickOutgoing(mine('hello', { from: FRIEND }), ctx)).toBeUndefined();
    expect(pickOutgoing(answer('ok', { requester: FRIEND }), ctx)).toBeUndefined();
    expect(pickOutgoing(answer('ok', { owner: FRIEND }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('by agent', { byAgent: true }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('via', { via: { name: 'x' } as Extract<Action, { type: 'chat' }>['via'] }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('app', { fromApp: 'tool' }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('room', { channel: 'room' }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('none', { channel: undefined }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('shared', { channel: 'ws:shared' }), ctx)).toBeUndefined();
    expect(pickOutgoing(mine('thread', { channel: 'ws:t' }), ctx)).toBeUndefined();
  });

  it('sends only finished answers, never tool steps', () => {
    const store = storeWith();
    for (const event of ['started', 'text', 'tool', 'error'] as const) expect(pickOutgoing(answer('x', { event }), ctxOf(store))).toBeUndefined();
  });

  it('leaves out excluded projects and what came before it was turned on', () => {
    const store = storeWith();
    expect(pickOutgoing(mine('b', { channel: 'ws:b' }), ctxOf(store, { excluded: ['p2'] }))).toBeUndefined();
    expect(pickOutgoing(mine('a'), ctxOf(store, { excluded: ['p2'] }))).toBeDefined();
    expect(pickOutgoing(mine('old', { ts: NOW - 1 }), ctxOf(store, { since: NOW }))).toBeUndefined();
  });

  it('leaves out secrets and command output', () => {
    expect(cleanText('my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBeUndefined();
    expect(cleanText('DATABASE_URL=postgres://u:hunter22@db:5432/x')).toBeUndefined();
    expect(cleanText('```console\n$ ls\nsecret.txt\n```')).toBeUndefined();
    expect(cleanText('Ran it:\n```console\n$ npm test\nok\n```\nAll green.')).toBe('Ran it:\n[…]\nAll green.');
    expect(cleanText('```beluga-graph\n{}\n```\nHere is the map')).toBe('[…]\nHere is the map');
    expect(cleanText('   ')).toBeUndefined();
  });
});

describe('the queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends in order, one session per batch, and skips what it has seen', async () => {
    const batches: string[][] = [];
    const queue = new HonchoQueue({ deliver: async (b) => void batches.push(b.map((i) => i.id)), onSent: () => undefined, onError: () => undefined });
    queue.push(item('1', 's1'));
    queue.push(item('2', 's2'));
    queue.push(item('3', 's1'));
    queue.push(item('1', 's1'));
    await vi.runAllTimersAsync();
    expect(batches).toEqual([['1', '3'], ['2']]);
    expect(queue.size).toBe(0);
  });

  it('retries with backoff when Honcho is down, then gives up quietly', async () => {
    const errors: string[] = [];
    let tries = 0;
    const queue = new HonchoQueue({
      deliver: async () => {
        tries += 1;
        throw new HonchoError('Couldn’t reach Honcho at that address', true);
      },
      onSent: () => undefined,
      onError: (m) => errors.push(m),
      maxAttempts: 3,
      baseDelayMs: 1000,
    });
    queue.push(item('1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tries).toBe(3);
    expect(queue.size).toBe(0);
    expect(errors).toHaveLength(3);
  });

  it('drops a batch Honcho refuses for good, and goes on with the next', async () => {
    const sent: string[] = [];
    const queue = new HonchoQueue({
      deliver: async (b) => {
        if (b[0]!.id === 'bad') throw new HonchoError('Honcho turned the request down as malformed', false);
        sent.push(b[0]!.id);
      },
      onSent: () => undefined,
      onError: () => undefined,
    });
    queue.push(item('bad', 's1'));
    queue.push(item('good', 's2'));
    await vi.runAllTimersAsync();
    expect(sent).toEqual(['good']);
  });

  it('keeps at most its cap, oldest out first', () => {
    const queue = new HonchoQueue({ deliver: () => new Promise(() => undefined), onSent: () => undefined, onError: () => undefined, maxItems: 2 });
    queue.push(item('1'));
    queue.push(item('2'));
    queue.push(item('3'));
    expect(queue.size).toBe(2);
  });
});

describe('the client', () => {
  it('speaks Honcho’s v3 API with a bearer key, to a plain http address on the network', async () => {
    const { fetch, calls } = fakeFetch();
    const client = new HonchoClient({ url: 'http://192.168.2.125:8000/', apiKey: KEY, workspace: 'beluga', fetch });
    await client.ensureSession('beluga-ws_a', [{ id: 'user', role: 'user' }, { id: 'agent-claude', role: 'agent' }], { kind: 'worktree' });
    await client.addMessages('beluga-ws_a', [{ peerId: 'user', content: 'hi', createdAt: NOW }]);
    expect(calls[0]).toMatchObject({ url: 'http://192.168.2.125:8000/v3/workspaces/beluga/sessions', auth: `Bearer ${KEY}`, body: { id: 'beluga-ws_a', peers: { user: { observe_me: true }, 'agent-claude': { observe_me: false } } } });
    expect(calls[1]).toMatchObject({ url: 'http://192.168.2.125:8000/v3/workspaces/beluga/sessions/beluga-ws_a/messages', body: { messages: [{ peer_id: 'user', content: 'hi', created_at: new Date(NOW).toISOString() }] } });
  });

  it('sends no auth header without a key, and says what went wrong without the key in it', async () => {
    const { fetch, calls } = fakeFetch(() => 401);
    const client = new HonchoClient({ url: 'http://localhost:8000', workspace: 'beluga', fetch });
    await expect(client.test()).rejects.toMatchObject({ message: 'Honcho refused the API key', retry: false });
    expect(calls[0]!.auth).toBeUndefined();
  });

  it('treats a network failure and a 5xx as worth retrying', async () => {
    const down = new HonchoClient({ url: 'http://localhost:8000', workspace: 'w', fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    await expect(down.ensureWorkspace()).rejects.toMatchObject({ retry: true });
    const busy = new HonchoClient({ url: 'http://localhost:8000', workspace: 'w', fetch: fakeFetch(() => 503).fetch });
    await expect(busy.ensureWorkspace()).rejects.toMatchObject({ retry: true });
  });
});

describe('the feed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const feedWith = (fetch: HonchoFetch, file: string | null = null) => {
    const store = storeWith();
    const feed = new HonchoFeed({ store, sharedWith: (c) => c === 'ws:shared', file, fetch, now: () => NOW });
    feed.start();
    return { store, feed };
  };

  it('sends nothing while off or never set up', async () => {
    const { fetch, calls } = fakeFetch();
    const { store, feed } = feedWith(fetch);
    store.dispatch(mine('hello'));
    store.dispatch(answer('hi'));
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
    expect(feed.status()).toMatchObject({ enabled: false, sent: 0, queued: 0 });
  });

  it('turned on, sends your words and your agent’s answer into one session, setting up the workspace, peers and session once', async () => {
    const { fetch, calls } = fakeFetch();
    const { store, feed } = feedWith(fetch);
    feed.configure({ enabled: true, url: 'http://192.168.2.125:8000' });
    store.dispatch(mine('fix the login'));
    store.dispatch(answer('fixed'));
    store.dispatch(mine('ignore me', { from: FRIEND }));
    await vi.runAllTimersAsync();
    store.dispatch(mine('thanks'));
    await vi.runAllTimersAsync();
    const routes = calls.map((c) => c.url.replace('http://192.168.2.125:8000', ''));
    expect(routes).toEqual([
      '/v3/workspaces',
      '/v3/workspaces/beluga/peers',
      '/v3/workspaces/beluga/peers',
      '/v3/workspaces/beluga/sessions',
      '/v3/workspaces/beluga/sessions/beluga-ws_a/messages',
      '/v3/workspaces/beluga/sessions/beluga-ws_a/messages',
    ]);
    const sentWords = calls.filter((c) => c.url.endsWith('/messages')).flatMap((c) => (c.body.messages as { content: string }[]).map((m) => m.content));
    expect(sentWords).toEqual(['fix the login', 'fixed', 'thanks']);
    expect(feed.status()).toMatchObject({ enabled: true, sent: 3, lastSentAt: NOW, queued: 0 });
  });

  it('never blocks: a dispatch returns before Honcho answers, and Honcho being down only leaves a note', async () => {
    const { fetch } = fakeFetch(() => 503);
    const { store, feed } = feedWith(fetch);
    feed.configure({ enabled: true });
    expect(() => store.dispatch(mine('hello'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status()).toMatchObject({ sent: 0, lastError: 'Honcho answered 503' });
  });

  it('turning it off drops what waits and stops sending', async () => {
    const { fetch, calls } = fakeFetch();
    const { store, feed } = feedWith(fetch);
    feed.configure({ enabled: true });
    feed.configure({ enabled: false });
    store.dispatch(mine('after'));
    await vi.runAllTimersAsync();
    expect(calls).toEqual([]);
  });

  it('keeps the key in a file only you can read, and never in its status', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'honcho-'));
    const file = path.join(dir, 'honcho.json');
    const { feed } = feedWith(fakeFetch().fetch, file);
    const status = feed.configure({ apiKey: KEY, url: 'http://localhost:8000' });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.hasKey).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadHonchoConfig(file).apiKey).toBe(KEY);
    expect(readFileSync(file, 'utf8')).toContain('"enabled": false');
    expect(feed.configure({ apiKey: null }).hasKey).toBe(false);
  });

  it('tests a draft address and key without saving them', async () => {
    const { fetch, calls } = fakeFetch();
    const { feed } = feedWith(fetch);
    expect(await feed.test({ url: 'http://nas.local:8000', apiKey: KEY })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: 'http://nas.local:8000/v3/workspaces', auth: `Bearer ${KEY}` });
    expect(feed.status()).toMatchObject({ hasKey: false, url: 'http://localhost:8000' });
  });
});

describe('the API', () => {
  it('takes plain http addresses on the network and refuses other schemes', () => {
    expect(parseArgs('honcho.configure', [{ url: 'http://192.168.2.125:8000', enabled: true }])).toEqual([{ url: 'http://192.168.2.125:8000', enabled: true }]);
    expect(() => parseArgs('honcho.configure', [{ url: 'file:///etc/passwd' }])).toThrow();
    expect(() => parseArgs('honcho.configure', [{ workspace: 'bad name' }])).toThrow();
    expect(() => parseArgs('honcho.configure', [{ other: 1 }])).toThrow();
  });
});
