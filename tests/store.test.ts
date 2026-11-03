import { describe, expect, it } from 'vitest';
import { Store, WRITTEN_LIMIT, fileKey, initialState as domainState, peerName, type AppState } from '../src/core/store.js';
import { initialAppState as initialState, reduceApp as reduce } from '../src/client/screen.js';
import type { PeerInfo } from '../src/protocol.js';

const peers: PeerInfo[] = [
  { peerId: 'me', name: 'kay', agent: true, shares: [{ name: 'app', writable: true }] },
  { peerId: 'b', name: 'bob', agent: true, shares: [{ name: 'api', writable: false }] },
];
const base = (): AppState => reduce(reduce(initialState('room'), { type: 'peers', peers }), { type: 'welcome', self: peers[0]! });
const at = { owner: 'b', share: 'api', path: '' };

describe('store reducer', () => {
  it('builds root browser rows from peer shares', () => {
    expect(base().browser.rows.map((r) => r.label)).toEqual(['kay · app', 'bob · api (read-only)']);
    expect(peerName(base(), 'b')).toBe('bob');
    expect(peerName(base(), 'unknown-peer')).toBe('unknow');
  });

  it('keeps when each watched file was last written, the most recent few hundred', () => {
    const gif = { owner: 'b', share: 'api', path: 'fire.gif' };
    const s1 = reduce(base(), { type: 'file_written', at: gif, ts: 10 });
    expect(base().written).toEqual({});
    expect(s1.written[fileKey(gif)]).toBe(10);
    expect(reduce(s1, { type: 'file_written', at: gif, ts: 20 }).written[fileKey(gif)]).toBe(20);
    let s = s1;
    for (let i = 0; i < WRITTEN_LIMIT; i++) s = reduce(s, { type: 'file_written', at: { ...gif, path: `f${i}.png` }, ts: i });
    expect(Object.keys(s.written)).toHaveLength(WRITTEN_LIMIT);
    expect(s.written[fileKey(gif)]).toBeUndefined();
    // Written again, it's the newest: kept over older ones.
    s = reduce(reduce(s, { type: 'file_written', at: { ...gif, path: 'f0.png' }, ts: 99 }), { type: 'file_written', at: gif, ts: 100 });
    expect(s.written[fileKey({ ...gif, path: 'f0.png' })]).toBe(99);
    expect(s.written[fileKey({ ...gif, path: 'f1.png' })]).toBeUndefined();
  });

  it('adds chat and system lines without mutating', () => {
    const s0 = base();
    const s1 = reduce(s0, { type: 'chat', id: '1', from: 'b', text: 'yo', ts: 1, byAgent: true });
    expect(s0.log).toHaveLength(0);
    expect(s1.log[0]).toMatchObject({ type: 'chat', name: "bob's Claude", text: 'yo' });
    const s2 = reduce(s1, { type: 'system', text: 'hi', level: 'warn' });
    expect(s2.log[1]).toMatchObject({ type: 'system', level: 'warn' });
    expect(reduce(s2, { type: 'clear', channel: 'room' }).log).toHaveLength(0);
  });

  it('accumulates agent events into one log item', () => {
    let s = base();
    const ev = (event: 'started' | 'text' | 'tool' | 'done', text = '') =>
      ({ type: 'agent_event', owner: 'b', requestId: 'r1', requester: 'me', event, text, ts: 1 }) as const;
    s = reduce(s, ev('started'));
    s = reduce(s, ev('tool', 'Read a.ts'));
    s = reduce(s, ev('text', 'looking'));
    s = reduce(s, ev('text', 'found it'));
    expect(s.log).toHaveLength(1);
    expect(s.log[0]).toMatchObject({ status: 'started', text: 'looking\n\nfound it', steps: ['Read a.ts'], ownerName: 'bob', requesterName: 'kay' });
    s = reduce(s, { ...ev('done', 'final answer'), ts: 9 });
    expect(s.log[0]).toMatchObject({ status: 'done', text: 'final answer', endTs: 9 });
    expect(reduce(s, { type: 'dir_cache', key: 'b:api/', entries: [] }).dirCache).toEqual({ 'b:api/': [] });
  });

  it('navigates the browser', () => {
    let s = reduce(base(), { type: 'browser_loading', at });
    expect(s.browser.loading).toBe(true);
    s = reduce(s, { type: 'browser_entries', at: { ...at, path: 'other' }, entries: [] });
    expect(s.browser.loading).toBe(true); // stale response ignored
    s = reduce(s, { type: 'browser_entries', at, entries: [{ name: 'src', dir: true, size: 0 }, { name: 'a.md', dir: false, size: 3 }] });
    expect(s.browser.rows.map((r) => r.label)).toEqual(['..', 'src', 'a.md']);
    expect(s.browser.rows[1]?.target).toEqual({ ...at, path: 'src' });
    s = reduce(s, { type: 'browser_cursor', delta: 10 });
    expect(s.browser.cursor).toBe(2);
    s = reduce(s, { type: 'browser_cursor', delta: -10 });
    expect(s.browser.cursor).toBe(0);
    s = reduce(s, { type: 'browser_error', error: 'boom' });
    expect(s.browser.error).toBe('boom');
    expect(reduce(s, { type: 'browser_root' }).browser.at).toBeUndefined();
  });

  it('manages the viewer', () => {
    const file = { ...at, path: 'a.md' };
    let s = reduce(base(), { type: 'viewer_open', at: file, by: 'bob' });
    expect(s.viewer).toMatchObject({ loading: true, by: 'bob' });
    s = reduce(s, { type: 'viewer_content', at: file, content: 'a\nb\nc', truncated: false });
    s = reduce(s, { type: 'viewer_scroll', delta: 99 });
    expect(s.viewer?.scroll).toBe(2);
    expect(reduce(s, { type: 'viewer_scroll', delta: 99, max: 10 }).viewer?.scroll).toBe(10); // rendered view can be longer
    s = reduce(s, { type: 'viewer_open', at: file });
    expect(s.viewer).toMatchObject({ content: 'a\nb\nc', scroll: 2 }); // reopen keeps content/scroll
    expect(reduce(s, { type: 'viewer_content', at: at, content: 'x', truncated: false })).toBe(s);
    s = reduce(s, { type: 'viewer_error', at: file, error: 'gone' });
    expect(s.viewer?.error).toBe('gone');
    expect(reduce(s, { type: 'viewer_close' }).viewer).toBeUndefined();
    expect(reduce(base(), { type: 'viewer_scroll', delta: 1 }).viewer).toBeUndefined();
  });

  it('tracks approvals, follow, trust and policy', () => {
    let s = reduce(base(), { type: 'approval_add', approval: { id: 'a', kind: 'tool', title: 't', detail: 'd' } });
    expect(s.approvals).toHaveLength(1);
    s = reduce(s, { type: 'approval_remove', id: 'a' });
    expect(s.approvals).toHaveLength(0);
    s = reduce(s, { type: 'follow', peerId: 'b' });
    s = reduce(s, { type: 'peers', peers: [peers[0]!] });
    expect(s.follow).toBeUndefined(); // followed peer left
    s = reduce(s, { type: 'peers', peers });
    s = reduce(s, { type: 'trust', peerId: 'b', trusted: true });
    s = reduce(s, { type: 'trust', peerId: 'b', trusted: true });
    expect(s.levels).toEqual({ b: 'trusted' });
    expect(reduce(s, { type: 'peers', peers: [peers[0]!] }).levels).toEqual({}); // re-applied from saved choices when they return
    expect(reduce(s, { type: 'trust', peerId: 'b', trusted: false }).levels).toEqual({ b: 'ask' });
    expect(reduce(s, { type: 'policy', policy: 'deny' }).policy).toBe('deny');
    s = reduce(s, { type: 'focus', actorKey: 'b:agent', focus: { ...at, actor: 'agent', ts: 1 } });
    expect(s.focus['b:agent']?.actor).toBe('agent');
    expect(reduce(s, { type: 'status', status: 'connected' }).status).toBe('connected');
    expect(reduce(s, { type: 'invite', invite: 'x' }).invite).toBe('x');
  });
});

describe('sanitizing', () => {
  it('strips terminal escape sequences from peer text', () => {
    let s = reduce(base(), { type: 'chat', id: '1', from: 'b', text: 'hi\u001b]52;c;ZXZpbA==\u0007\u001b[2Jthere\r', ts: 1, byAgent: false });
    expect(s.log[0]).toMatchObject({ text: 'hi]52;c;ZXZpbA==[2Jthere' });
    s = reduce(s, { type: 'approval_add', approval: { id: 'a', kind: 'tool', title: 'x\u001b[1A', detail: 'ls\n\u009bpwd' } });
    expect(s.approvals[0]).toMatchObject({ title: 'x[1A', detail: 'ls\npwd' });
  });
});

describe('Store', () => {
  it('notifies subscribers only on change', () => {
    const store = new Store(domainState('r'));
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: 'policy', policy: 'auto' });
    store.dispatch({ type: 'trust', peerId: 'nobody', trusted: false }); // no-op returns same state
    off();
    store.dispatch({ type: 'policy', policy: 'ask' });
    expect(calls).toBe(1);
    expect(store.getState().policy).toBe('ask');
  });
});
