import { describe, expect, it, vi } from 'vitest';
import { chatJumpState } from '../src/ui/chat-jump.js';
import { asSent } from '../src/shared/claude-notices.js';
import { withLiveTails } from '../packages/mac/src/chat/live-tail.js';
import { type LogItem, Store, initialState } from '../src/core/store.js';
import { type UiActionContext, runUiActionWith } from '../src/ui/ui-actions.js';

const rows = [
  { id: 'a', ts: 10 },
  { id: 'b', ts: 20 },
  { id: 'c', ts: 20 },
  { id: 'd', ts: 30 },
];
const jump = { channel: 'ws:1', ts: 20, at: 1000 };

describe('chatJumpState', () => {
  it('finds the first row said at that moment', () => {
    expect(chatJumpState(jump, 'ws:1', rows, 1001)).toEqual({ state: 'go', index: 1 });
  });

  it('ignores a jump for another conversation', () => {
    expect(chatJumpState(jump, 'ws:2', rows, 1001)).toEqual({ state: 'none' });
    expect(chatJumpState(undefined, 'ws:1', rows, 1001)).toEqual({ state: 'none' });
  });

  it('finds the row by its item id, whatever its time', () => {
    expect(chatJumpState({ ...jump, id: 'c', ts: 999 }, 'ws:1', rows, 1001)).toEqual({ state: 'go', index: 2 });
  });

  it('finds a message that ran from the queue, which the chat draws at queuedUntil, by its item id', () => {
    const channel = 'ws:1';
    const said = (id: string, text: string, ts: number): LogItem => ({ id, type: 'chat', channel, from: 'me', name: 'kay', text, ts, byAgent: false, ...(id === 'queued' ? { request: 'r2' } : {}) });
    const card: LogItem = { id: 'card', type: 'agent', channel, subagents: [], requestId: 'r2', owner: 'me', ownerName: 'kay', requesterName: 'kay', status: 'done', text: 'done', steps: [], ts: 21, queuedUntil: 50 };
    const items = [said('first', 'go', 10), said('queued', 'the pomelo message', 20), card, said('later', 'more', 40)];
    const drawn = asSent(items, () => true);
    const index = drawn.findIndex((r) => r.id === 'queued');
    expect(drawn[index]!.ts).toBe(50);
    // By its time alone, the row isn't found.
    expect(chatJumpState({ channel, ts: 20, at: 1000 }, channel, drawn, 1001).state).not.toBe('go');
    expect(chatJumpState({ channel, id: 'queued', ts: 20, at: 1000 }, channel, drawn, 1001)).toEqual({ state: 'go', index });
  });

  it('goes to the part of a split turn that holds its answer, not to where the turn began', () => {
    const channel = 'ws:1';
    const said = (id: string, text: string, ts: number): LogItem => ({ id, type: 'chat', channel, from: 'me', name: 'kay', text, ts, byAgent: false });
    const card: LogItem = { id: 'c', type: 'agent', channel, subagents: [], requestId: 'r1', owner: 'me', ownerName: 'kay', requesterName: 'kay', status: 'done', text: 'the persimmon answer', steps: [], ts: 11, endTs: 50 };
    const shown = withLiveTails([said('u', 'go', 10), card, said('m', 'and one more thing', 20)]);
    const rows = shown.map((x) => ({ id: x.row.id, ts: x.row.ts, side: x.part?.side }));
    expect(shown.map((x) => x.key)).toEqual(['u', 'c', 'm', 'c:tail']);
    expect(chatJumpState({ channel, id: 'c', ts: 11, at: 1000 }, channel, rows, 1001)).toEqual({ state: 'go', index: 3 });
  });

  it('falls back on the time when the item has no id', () => {
    expect(chatJumpState({ ...jump, ts: 30 }, 'ws:1', rows, 1001)).toEqual({ state: 'go', index: 3 });
  });

  it('waits while the conversation has no rows yet', () => {
    expect(chatJumpState(jump, 'ws:1', [], 1001)).toEqual({ state: 'wait' });
  });

  it('says a message is lost only when it is older than the oldest row the chat has', () => {
    expect(chatJumpState({ ...jump, id: 'gone', ts: 5 }, 'ws:1', rows, 1001)).toEqual({ state: 'lost' });
    expect(chatJumpState({ ...jump, ts: 5 }, 'ws:1', rows, 1001)).toEqual({ state: 'lost' });
  });

  it('ends the jump quietly when a message the chat does not draw is no older than its rows', () => {
    expect(chatJumpState({ ...jump, id: 'gone' }, 'ws:1', rows, 1001)).toEqual({ state: 'drop' });
    expect(chatJumpState({ ...jump, ts: 25 }, 'ws:1', rows, 1001)).toEqual({ state: 'drop' });
  });

  it('ends the jump quietly when a message waits in the queue (the chat draws it above the box)', () => {
    const channel = 'ws:1';
    const said = (id: string, text: string, ts: number, request?: string): LogItem => ({ id, type: 'chat', channel, from: 'me', name: 'kay', text, ts, byAgent: false, ...(request ? { request } : {}) });
    const card: LogItem = { id: 'card', type: 'agent', channel, subagents: [], requestId: 'r2', owner: 'me', ownerName: 'kay', requesterName: 'kay', status: 'queued', text: '', steps: [], ts: 21 };
    const drawn = asSent([said('first', 'go', 10), said('queued', 'the pomelo message', 20, 'r2'), card], () => true);
    expect(drawn.some((r) => r.id === 'queued')).toBe(false);
    expect(chatJumpState({ channel, id: 'queued', ts: 20, at: 1000 }, channel, drawn, 1001)).toEqual({ state: 'drop' });
  });

  it('ends the jump quietly when no rows ever came: an empty chat is not a chat that lost its message', () => {
    expect(chatJumpState(jump, 'ws:1', [], 1000 + 10_001)).toEqual({ state: 'drop' });
  });

  it('drops an old jump, even when its row is there: it is not what you just asked for', () => {
    expect(chatJumpState(jump, 'ws:1', rows, 1000 + 10_001)).toEqual({ state: 'drop' });
    expect(chatJumpState({ ...jump, ts: 25 }, 'ws:1', rows, 1000 + 10_001)).toEqual({ state: 'drop' });
  });
});

describe('the search_hit action', () => {
  it('opens the hit and asks the chat to jump to its message', () => {
    const store = new Store(initialState('r'));
    const hit = { channel: 'mac:assistant', place: 'p', who: 'k', text: 'x', at: 0, ts: 42, id: 'i7' };
    store.dispatch({ type: 'search', search: { query: 'x', hits: [hit], searched: 1 } });
    const openHit = vi.fn(async () => undefined);
    const patchUi = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(77);
    runUiActionWith({ client: { store, api: { workbench: { openHit } } }, patchUi, menuCtx: () => ({ client: { store, api: {} } }) } as unknown as UiActionContext, { type: 'search_hit', index: 0 });
    vi.restoreAllMocks();
    expect(openHit).toHaveBeenCalledWith(0);
    expect(patchUi).toHaveBeenCalledWith({ focus: 'chat', chatJump: { channel: 'mac:assistant', id: 'i7', ts: 42, at: 77 } });
  });
});
