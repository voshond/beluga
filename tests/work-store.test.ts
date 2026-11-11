import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_MODELS, initialWork, reduceWork, unreadCount, type Notice, type PullRequest, type WorkState } from '../src/core/work-store.js';
import { DEFAULT_PREFS, initialState, prefsFrom, reduce, stampAction, type DomainState } from '../src/core/store.js';
import type { PeerInfo } from '../src/protocol.js';

const note = (title: string, channel?: string): Omit<Notice, 'id' | 'ts' | 'read'> => ({ kind: 'done', title, body: `${title} body`, ...(channel ? { channel } : {}) });
const add = (s: WorkState, title: string, channel?: string): WorkState => reduceWork(s, stampAction({ type: 'notice_add', notice: note(title, channel) }) as Parameters<typeof reduceWork>[1]);
const pr: PullRequest = { number: 7, url: 'https://x/pr/7', state: 'OPEN', title: 'Fix', draft: false, checks: 'passing' };

describe('reduceWork: inbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => vi.useRealTimers());

  it('adds notices newest first with increasing ids, unread, timestamped', () => {
    const s = add(add(initialWork, 'a', 'room'), 'b');
    expect(s.inbox.map((n) => [n.id, n.title, n.read, n.ts])).toEqual([
      [2, 'b', false, 1000],
      [1, 'a', false, 1000],
    ]);
    expect(s.inbox[1]).toMatchObject({ kind: 'done', body: 'a body', channel: 'room' });
    expect(initialWork.inbox).toEqual([]);
  });

  it('caps the inbox at 100, dropping the oldest', () => {
    let s = initialWork;
    for (let i = 0; i < 105; i++) s = add(s, `n${i}`);
    expect(s.inbox).toHaveLength(100);
    expect(s.inbox[0]!.title).toBe('n104');
    expect(s.inbox[99]!.title).toBe('n5');
    expect(add(s, 'next').inbox[0]!.id).toBe(106);
  });

  it('marks everything read with no id or channel', () => {
    const s = reduceWork(add(add(initialWork, 'a', 'room'), 'b', 'ws:x'), { type: 'notice_read' });
    expect(s.inbox.every((n) => n.read)).toBe(true);
    expect(unreadCount(s)).toBe(0);
  });

  it('marks one notice read by id', () => {
    const s0 = add(add(add(initialWork, 'a'), 'b'), 'c');
    const s = reduceWork(s0, { type: 'notice_read', id: 2 });
    expect(s.inbox.map((n) => [n.id, n.read])).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ]);
    expect(unreadCount(s)).toBe(2);
    expect(s0.inbox.every((n) => !n.read)).toBe(true);
  });

  it('id wins over channel', () => {
    const s = reduceWork(add(add(initialWork, 'a', 'room'), 'b', 'room'), { type: 'notice_read', id: 1, channel: 'room' });
    expect(s.inbox.map((n) => n.read)).toEqual([false, true]);
  });

  it('marks a channel read, leaving other channels and channel-less notices', () => {
    let s = add(add(add(initialWork, 'a', 'ws:x'), 'b', 'room'), 'c');
    s = add(s, 'd', 'ws:x');
    s = reduceWork(s, { type: 'notice_read', channel: 'ws:x' });
    expect(s.inbox.map((n) => [n.title, n.read])).toEqual([
      ['d', true],
      ['c', false],
      ['b', false],
      ['a', true],
    ]);
  });

  it('keeps already-read notices as the same objects', () => {
    const s1 = reduceWork(add(add(initialWork, 'a'), 'b'), { type: 'notice_read', id: 1 });
    const s2 = reduceWork(s1, { type: 'notice_read' });
    expect(s2.inbox[1]).toBe(s1.inbox[1]);
  });

  it('clears the inbox and restarts ids', () => {
    const s = reduceWork(add(add(initialWork, 'a'), 'b'), { type: 'notice_clear' });
    expect(s.inbox).toEqual([]);
    expect(add(s, 'c').inbox[0]!.id).toBe(1);
  });

  it('unreadCount counts unread notices', () => {
    expect(unreadCount(initialWork)).toBe(0);
    expect(unreadCount(add(add(initialWork, 'a'), 'b'))).toBe(2);
  });
});

describe('reduceWork: other actions', () => {
  it('terminal exits are kept until the program starts again', () => {
    const s = reduceWork(reduceWork(initialWork, { type: 'terminal', id: 'w1', title: 'zsh' }), { type: 'terminal_exit', id: 'w1', code: 3 });
    expect(s.termExits).toEqual({ w1: 3 });
    expect(reduceWork(s, { type: 'terminal', id: 'w1', title: 'zsh' }).termExits).toEqual({});
    expect(reduceWork(s, { type: 'terminal', id: 'w1' })).toMatchObject({ terminals: {}, termExits: {} });
    expect(reduceWork(initialWork, { type: 'terminal_exit', id: 'gone', code: 0 })).toBe(initialWork);
  });

  it('a tool report is kept until the terminal starts again or closes', () => {
    const report = { status: 'success', message: 'Deployed' } as const;
    const s = reduceWork(reduceWork(initialWork, { type: 'terminal', id: 't1', title: 'deploy' }), { type: 'terminal_report', id: 't1', report });
    expect(s.termReports).toEqual({ t1: report });
    expect(reduceWork(s, { type: 'terminal', id: 't1', title: 'deploy' }).termReports).toEqual({ t1: report });
    const ended = reduceWork(s, { type: 'terminal_exit', id: 't1', code: 0 });
    expect(reduceWork(ended, { type: 'terminal', id: 't1', title: 'deploy' }).termReports).toEqual({});
    expect(reduceWork(s, { type: 'terminal', id: 't1' }).termReports).toEqual({});
    expect(reduceWork(initialWork, { type: 'terminal_report', id: 'gone', report })).toBe(initialWork);
  });

  it('a tool trail is the last line it showed, cleared when it starts again or closes', () => {
    const s = reduceWork(reduceWork(initialWork, { type: 'terminal', id: 't1', title: 'deploy' }), { type: 'terminal_trail', id: 't1', line: 'Building…' });
    expect(s.termTrails).toEqual({ t1: 'Building…' });
    const ended = reduceWork(s, { type: 'terminal_exit', id: 't1', code: 0 });
    expect(reduceWork(ended, { type: 'terminal', id: 't1', title: 'deploy' }).termTrails).toEqual({});
    expect(reduceWork(s, { type: 'terminal', id: 't1' }).termTrails).toEqual({});
    expect(reduceWork(initialWork, { type: 'terminal_trail', id: 'gone', line: 'x' })).toBe(initialWork);
  });

  it('models falls back to the built-in list when empty', () => {
    const models = [{ value: 'opus', label: 'Opus', description: 'big', efforts: ['high'] }];
    expect(reduceWork(initialWork, { type: 'models', models }).models).toBe(models);
    expect(reduceWork(initialWork, { type: 'models', models: [] }).models).toBe(FALLBACK_MODELS);
    expect(initialWork.models).toBe(FALLBACK_MODELS);
    expect(FALLBACK_MODELS[0]!.value).toBe('');
  });

  it('disk merges sizes', () => {
    const s = reduceWork(reduceWork(initialWork, { type: 'disk', sizes: { a: 1, b: 2 } }), { type: 'disk', sizes: { b: 3, c: 4 } });
    expect(s.disk).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('pr sets and removes by id', () => {
    const s = reduceWork(reduceWork(initialWork, { type: 'pr', id: 'w1', pr }), { type: 'pr', id: 'w2', pr: { ...pr, number: 8 } });
    expect(Object.keys(s.prs)).toEqual(['w1', 'w2']);
    const r = reduceWork(s, { type: 'pr', id: 'w1' });
    expect(r.prs).toEqual({ w2: { ...pr, number: 8 } });
    expect(reduceWork(r, { type: 'pr', id: 'missing' }).prs).toEqual(r.prs);
  });

  it('setup sets and removes by id', () => {
    const run = { status: 'running', command: 'npm i' } as const;
    const s = reduceWork(initialWork, { type: 'setup', id: 'w1', run });
    expect(s.setup).toEqual({ w1: run });
    const done = reduceWork(s, { type: 'setup', id: 'w1', run: { status: 'failed', command: 'npm i', detail: 'exit 1' } });
    expect(done.setup.w1).toMatchObject({ status: 'failed', detail: 'exit 1' });
    expect(reduceWork(done, { type: 'setup', id: 'w1' }).setup).toEqual({});
  });

  it('search merges partial state', () => {
    const hit = { channel: 'room', place: 'room', who: 'bob', text: 'hello', at: 0, ts: 1 };
    const s = reduceWork(initialWork, { type: 'search', search: { query: 'he', hits: [hit] } });
    expect(s.search).toEqual({ query: 'he', hits: [hit], searched: 0 });
    expect(reduceWork(s, { type: 'search', search: { searched: 3 } }).search).toMatchObject({ query: 'he', searched: 3 });
  });

  it('templates replaces the list', () => {
    const templates = [{ id: 't', name: 'Fix', prompt: 'fix it', plan: true }];
    expect(reduceWork(initialWork, { type: 'templates', templates }).templates).toBe(templates);
  });

  it('terminal opens, renames, no-ops on the same title, and closes', () => {
    const s = reduceWork(initialWork, { type: 'terminal', id: 'w1', title: 'zsh' });
    expect(s.terminals).toEqual({ w1: 'zsh' });
    expect(reduceWork(s, { type: 'terminal', id: 'w1', title: 'zsh' })).toBe(s);
    expect(reduceWork(s, { type: 'terminal', id: 'w1', title: 'vim' }).terminals).toEqual({ w1: 'vim' });
    expect(reduceWork(s, { type: 'terminal', id: 'w1' }).terminals).toEqual({});
  });

  it('terminal accepts an empty title', () => {
    expect(reduceWork(initialWork, { type: 'terminal', id: 'w1', title: '' }).terminals).toEqual({ w1: '' });
  });

  it('pr_custom, gh and remembered set their fields', () => {
    expect(reduceWork(initialWork, { type: 'pr_custom', custom: true }).prCustom).toBe(true);
    expect(initialWork.gh).toBeUndefined();
    expect(reduceWork(initialWork, { type: 'gh', ok: false }).gh).toBe(false);
    expect(reduceWork(initialWork, { type: 'gh', ok: true }).gh).toBe(true);
    const people = { abcdefgh: { name: 'bob', trust: 'trusted' as const } };
    expect(reduceWork(initialWork, { type: 'remembered', people }).remembered).toBe(people);
  });
});

describe('store reduce wires work actions', () => {
  it('routes every work action through reduce', () => {
    let s = initialState('r');
    s = reduce(s, { type: 'notice_add', notice: note('hi', 'room') });
    expect(s.inbox[0]).toMatchObject({ id: 1, title: 'hi', read: false });
    expect(unreadCount(s)).toBe(1);
    s = reduce(s, { type: 'notice_read', channel: 'room' });
    expect(unreadCount(s)).toBe(0);
    s = reduce(s, { type: 'notice_clear' });
    expect(s.inbox).toEqual([]);
    s = reduce(s, { type: 'models', models: [] });
    s = reduce(s, { type: 'disk', sizes: { w: 5 } });
    s = reduce(s, { type: 'pr', id: 'w', pr });
    s = reduce(s, { type: 'setup', id: 'w', run: { status: 'done', command: 'x' } });
    s = reduce(s, { type: 'search', search: { query: 'q' } });
    s = reduce(s, { type: 'templates', templates: [{ id: 't', name: 'n', prompt: 'p' }] });
    s = reduce(s, { type: 'terminal', id: 'w', title: 'sh' });
    s = reduce(s, { type: 'pr_custom', custom: true });
    s = reduce(s, { type: 'gh', ok: true });
    s = reduce(s, { type: 'remembered', people: { abcdefgh: { name: 'b', trust: 'ask' } } });
    expect(s).toMatchObject({
      models: FALLBACK_MODELS,
      disk: { w: 5 },
      prs: { w: pr },
      setup: { w: { status: 'done' } },
      search: { query: 'q' },
      templates: [{ id: 't' }],
      terminals: { w: 'sh' },
      prCustom: true,
      gh: true,
      remembered: { abcdefgh: { trust: 'ask' } },
      room: 'r',
    });
  });

  it('keeps the rest of the app state intact', () => {
    const s0 = initialState('r');
    const s = reduce(s0, { type: 'disk', sizes: { a: 1 } });
    expect(s.prefs).toBe(s0.prefs);
    expect(s.log).toBe(s0.log);
    expect(s0.disk).toEqual({});
  });
});

describe('prefs', () => {
  it('initialState uses defaults and merges partial prefs', () => {
    expect(initialState('r').prefs).toEqual(DEFAULT_PREFS);
    expect(initialState('r').policy).toBe('ask');
    const s = initialState('r', 'deny', { theme: 'mono', model: 'opus' });
    expect(s.policy).toBe('deny');
    expect(s.prefs).toEqual({ ...DEFAULT_PREFS, theme: 'mono', model: 'opus' });
    expect(DEFAULT_PREFS.theme).toBe('calm');
  });

  it('prefsFrom picks preference keys (including model, effort, shell) and ignores the rest', () => {
    const p = prefsFrom({ theme: 'light', mouse: false, model: 'sonnet', effort: 'high', shell: '/bin/zsh', name: 'kay', policy: 'auto', people: {} });
    expect(p).toEqual({ ...DEFAULT_PREFS, theme: 'light', mouse: false, model: 'sonnet', effort: 'high', shell: '/bin/zsh' });
    expect(p).not.toHaveProperty('name');
    expect(p).not.toHaveProperty('policy');
    expect(p).not.toHaveProperty('people');
  });

  it('prefsFrom of nothing is the defaults, and undefined values do not override', () => {
    expect(prefsFrom({})).toEqual(DEFAULT_PREFS);
    const p = prefsFrom({ theme: undefined, model: undefined });
    expect(p.theme).toBe('calm');
    expect(p).not.toHaveProperty('model');
  });

  it('prefs action merges', () => {
    const s = reduce(initialState('r'), { type: 'prefs', prefs: { mouse: false } });
    expect(s.prefs).toEqual({ ...DEFAULT_PREFS, mouse: false });
  });
});

describe('trust actions', () => {
  const s0 = (): DomainState => initialState('r');

  it('trust_level sets, replaces and clears a level', () => {
    let s = reduce(s0(), { type: 'trust_level', peerId: 'b', level: 'trusted' });
    expect(s.levels).toEqual({ b: 'trusted' });
    s = reduce(s, { type: 'trust_level', peerId: 'b', level: 'blocked' });
    expect(s.levels).toEqual({ b: 'blocked' });
    s = reduce(s, { type: 'trust_level', peerId: 'c', level: 'ask' });
    s = reduce(s, { type: 'trust_level', peerId: 'b' });
    expect(s.levels).toEqual({ c: 'ask' });
  });

  it('trust: on -> trusted, keeps full; off only takes back "trusted"', () => {
    let s = reduce(s0(), { type: 'trust', peerId: 'b', trusted: true });
    expect(s.levels.b).toBe('trusted');
    expect(reduce(s, { type: 'trust', peerId: 'b', trusted: false }).levels.b).toBe('ask');
    s = reduce(s, { type: 'trust_level', peerId: 'b', level: 'full' });
    expect(reduce(s, { type: 'trust', peerId: 'b', trusted: true }).levels.b).toBe('full');
    expect(reduce(s, { type: 'trust', peerId: 'b', trusted: false }).levels.b).toBe('full');
    const blocked = reduce(s0(), { type: 'trust_level', peerId: 'b', level: 'blocked' });
    expect(reduce(blocked, { type: 'trust', peerId: 'b', trusted: false }).levels.b).toBe('blocked');
  });

  it('full_trust: on -> full, off -> ask', () => {
    const s = reduce(s0(), { type: 'full_trust', peerId: 'b', trusted: true });
    expect(s.levels.b).toBe('full');
    expect(reduce(s, { type: 'full_trust', peerId: 'b', trusted: false }).levels.b).toBe('ask');
    const trusted = reduce(s0(), { type: 'trust_level', peerId: 'b', level: 'trusted' });
    expect(reduce(trusted, { type: 'full_trust', peerId: 'b', trusted: false }).levels.b).toBe('trusted');
  });

  it('peers prunes levels and access of people who left', () => {
    const peer = (peerId: string): PeerInfo => ({ peerId, name: peerId, agent: true, shares: [] });
    let s = reduce(s0(), { type: 'peers', peers: [peer('a'), peer('b')] });
    s = reduce(s, { type: 'trust_level', peerId: 'a', level: 'trusted' });
    s = reduce(s, { type: 'trust_level', peerId: 'b', level: 'full' });
    s = reduce(s, { type: 'access', peerId: 'a', scope: 'full' });
    s = reduce(s, { type: 'access', peerId: 'b', scope: 'folder' });
    s = reduce(s, { type: 'peers', peers: [peer('b')] });
    expect(s.levels).toEqual({ b: 'full' });
    expect(s.access).toEqual({ b: 'folder' });
    expect(reduce(s, { type: 'peers', peers: [] }).levels).toEqual({});
  });
});
