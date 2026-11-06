import { describe, expect, it } from 'vitest';
import type { LogItem } from '../src/core/store.js';
import { Store, initialState } from '../src/core/store.js';
import { READS_AFTER_STEP, STEERED_IN, asRead, steeredMessages } from '../src/shared/claude-notices.js';
import { withLiveTails } from '../packages/mac/src/chat/live-tail.js';

/** A steered message is drawn where the agent read it, and below everything until it does (BLG-47). */

type Agent = Extract<LogItem, { type: 'agent' }>;
const said = (id: string, ts: number, request?: string): LogItem => ({ id, type: 'chat', channel: 'ws:1', from: 'me', name: 'me', text: id, ts, byAgent: false, steer: true, ...(request ? { request } : {}) });
const card = (id: string, ts: number, more: Partial<Agent> = {}): Agent => ({ id: `c-${id}`, type: 'agent', channel: 'ws:1', requestId: id, owner: 'me', ownerName: 'me', requesterName: 'me', requester: 'me', status: 'started', text: '', steps: [], subagents: [], ts, ...more });
const ids = (rows: readonly LogItem[]) => rows.map((r) => r.id);
const placed = (items: readonly LogItem[]) => asRead(items, steeredMessages(items).waiting);

describe('asRead', () => {
  it('leaves a conversation with no steered messages as it is', () => {
    const items = [said('ask', 1), card('a', 2, { status: 'done', text: 'ok', endTs: 5 })];
    expect(placed(items)).toEqual({ rows: items, pinned: [] });
  });

  it('pins one the agent hasn’t read below everything, without splitting the turn it waits on', () => {
    const items = [said('ask', 1), card('a', 2), said('steer', 4, 's'), card('s', 4, { status: 'text', text: READS_AFTER_STEP })];
    const { rows, pinned } = placed(items);
    expect(ids(rows)).toEqual(['ask', 'c-a']);
    expect(ids(pinned)).toEqual(['steer']);
    expect(withLiveTails(rows).map((x) => x.key)).toEqual(['ask', 'c-a']);
  });

  it('pins one whose card hasn’t come yet', () => {
    const items = [said('ask', 1), card('a', 2), said('steer', 4, 's')];
    expect(ids(placed(items).pinned)).toEqual(['steer']);
  });

  it('draws one it read at the moment it read it, the turn split there', () => {
    const items = [said('ask', 1), card('a', 2), said('steer', 4, 's'), card('s', 4, { status: 'done', text: STEERED_IN, readAt: 9, endTs: 9 }), said('later', 6)];
    const { rows, pinned } = placed(items);
    expect(pinned).toEqual([]);
    expect(ids(rows)).toEqual(['ask', 'c-a', 'later', 'steer', 'c-s']);
    expect(withLiveTails(rows).find((x) => x.part?.side === 'head')?.part?.cut).toBe(6);
  });
});

describe('readAt', () => {
  const host = () => {
    const store = new Store(initialState('room', 'auto'));
    const ev = (event: 'text' | 'started' | 'done' | 'error' | 'queued', text: string, ts: number) => store.dispatch({ type: 'agent_event', owner: 'me', requestId: 's', requester: 'me', event, text, ts, channel: 'ws:1' });
    const readAt = () => (store.getState().log.find((l): l is Agent => l.type === 'agent')?.readAt);
    return { ev, readAt };
  };

  it('is when its note gave way: taken in, or its own turn', () => {
    const a = host();
    a.ev('text', READS_AFTER_STEP, 2);
    expect(a.readAt()).toBeUndefined();
    a.ev('done', STEERED_IN, 7);
    expect(a.readAt()).toBe(7);
    const b = host();
    b.ev('text', READS_AFTER_STEP, 2);
    b.ev('started', '', 5);
    expect(b.readAt()).toBe(5);
  });

  it('not when it goes back in line, or a newer note replaces it', () => {
    const a = host();
    a.ev('text', READS_AFTER_STEP, 2);
    a.ev('queued', 'steer', 4);
    expect(a.readAt()).toBeUndefined();
    const b = host();
    b.ev('text', READS_AFTER_STEP, 2);
    b.ev('error', 'The agent’s run ended before it read your message', 4);
    expect(b.readAt()).toBeUndefined();
  });
});
