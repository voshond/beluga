import { describe, expect, it } from 'vitest';
import type { LogItem } from '../src/core/store.js';
import { Store, initialState } from '../src/core/store.js';
import { asSent } from '../src/shared/claude-notices.js';
import { inYourQueue } from '../src/ui/compose.js';
import { withLiveTails } from '../packages/mac/src/chat/live-tail.js';

/** A message waiting its turn sits in the queue above the box, not in the chat; once it runs, it's drawn where it ran (BLG-317). */

type Agent = Extract<LogItem, { type: 'agent' }>;
const said = (id: string, ts: number, request?: string): LogItem => ({ id, type: 'chat', channel: 'ws:1', from: 'me', name: 'me', text: id, ts, byAgent: false, ...(request ? { request } : {}) });
const card = (id: string, ts: number, more: Partial<Agent> = {}): Agent => ({ id: `c-${id}`, type: 'agent', channel: 'ws:1', requestId: id, owner: 'me', ownerName: 'me', requesterName: 'me', requester: 'me', status: 'started', text: '', steps: [], subagents: [], ts, ...more });
const mine = (l: Agent) => inYourQueue(l, 'me');
const ids = (rows: readonly LogItem[]) => rows.map((r) => r.id);

describe('asSent', () => {
  it('leaves a conversation with nothing queued as it is', () => {
    const items = [said('ask', 1, 'a'), card('a', 2, { status: 'done', text: 'ok', endTs: 5 })];
    expect(asSent(items, mine)).toBe(items);
  });

  it('keeps a queued message and its card out of the chat', () => {
    const items = [said('ask', 1, 'a'), card('a', 2), said('next', 3, 'b'), card('b', 3, { status: 'queued', prompt: 'next' })];
    expect(ids(asSent(items, mine))).toEqual(['ask', 'c-a']);
  });

  it('draws a queued message where it ran, after the answer Claude gave meanwhile', () => {
    const items = [said('ask', 1, 'a'), card('a', 2, { status: 'done', text: 'ok', endTs: 8 }), said('next', 3, 'b'), card('b', 3, { status: 'started', queuedUntil: 8 })];
    const rows = asSent(items, mine);
    expect(ids(rows)).toEqual(['ask', 'c-a', 'next', 'c-b']);
    expect(rows.slice(2).map((r) => r.ts)).toEqual([8, 8]);
    // So the answer above isn't split around it.
    expect(withLiveTails(rows).map((x) => x.key)).toEqual(['ask', 'c-a', 'next', 'c-b']);
    // The same rows each time (a row's memo holds).
    expect(asSent(items, mine)[2]).toBe(rows[2]);
  });

  it('never draws one taken back out of the queue', () => {
    const items = [said('ask', 1, 'a'), card('a', 2), said('next', 3, 'b'), card('b', 3, { status: 'error', text: 'Taken out of the queue when you stopped Claude', queuedUntil: 6, endTs: 6 })];
    expect(ids(asSent(items, mine))).toEqual(['ask', 'c-a']);
  });

  it('keeps one waiting for a free Claude in the chat, where it can start now', () => {
    const items = [said('ask', 1, 'a'), card('a', 2, { status: 'queued', slotWait: { running: 1, limit: 1 } })];
    expect(ids(asSent(items, mine))).toEqual(['ask', 'c-a']);
  });

  it('keeps a message sent during a turn out of the chat before its card comes', () => {
    const waiting = { ...said('next', 3, 'b'), queued: true } as LogItem;
    const items = [said('ask', 1, 'a'), card('a', 2), waiting];
    expect(ids(asSent(items, mine))).toEqual(['ask', 'c-a']);
    // Its card came: queued, it stays in the queue; started, it is drawn as usual.
    expect(ids(asSent([...items, card('b', 3, { status: 'queued', prompt: 'next' })], mine))).toEqual(['ask', 'c-a']);
    expect(ids(asSent([...items, card('b', 3)], mine))).toEqual(['ask', 'c-a', 'next', 'c-b']);
  });

  it('leaves what someone else waits for in the chat (it isn’t in your queue)', () => {
    const items = [said('ask', 1), card('x', 3, { status: 'queued', owner: 'bob', ownerName: 'bob', requester: 'bob', requesterName: 'bob' })];
    expect(ids(asSent(items, mine))).toEqual(['ask', 'c-x']);
  });
});

describe('store', () => {
  it('marks when a card left the queue', () => {
    const store = new Store(initialState('me'));
    const ev = (event: 'queued' | 'started', ts: number) => store.dispatch({ type: 'agent_event', owner: 'me', requestId: 'b', requester: 'me', event, text: event === 'queued' ? 'next' : '', ts, channel: 'ws:1' });
    ev('queued', 3);
    expect(store.getState().log.find((l) => l.type === 'agent')).not.toHaveProperty('queuedUntil');
    ev('started', 8);
    expect(store.getState().log.find((l) => l.type === 'agent')).toMatchObject({ status: 'started', queuedUntil: 8 });
  });
});
