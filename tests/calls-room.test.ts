import { describe, expect, it } from 'vitest';
import { ROOM_CONVERSATION, roomLinks } from '../src/core/calls/room.js';
import { CallService } from '../src/core/calls/service.js';
import { Store, initialState } from '../src/core/store.js';
import { type CallsView, type MissedCallView, RING_MS } from '../src/shared/calls.js';

/** Someone in a room: their store says who's connected; frames to others go straight to their inbox. */
function person(id: string, everyone: readonly { peerId: string; name: string; guest?: boolean }[]) {
  const store = new Store({ ...initialState('room'), selfId: id });
  store.dispatch({ type: 'status', status: 'connected' });
  store.dispatch({ type: 'peers', peers: everyone.map((p) => ({ ...p, shares: [], agent: true })) });
  let view: CallsView = {};
  const signals: string[] = [];
  const missed: MissedCallView[] = [];
  const toasts: string[] = [];
  const clock = { now: 1_000_000 };
  const inbox: Record<string, (from: string, p: unknown) => void> = {};
  const room = roomLinks({ store, send: (to, p) => (inbox[to] ? (inbox[to](id, p), true) : false) });
  const calls = new CallService({
    links: room.links,
    manual: true,
    now: () => clock.now,
    publish: (v) => (view = v),
    signal: (_to, s) => signals.push(s.data),
    ring: () => undefined,
    toast: (t) => toasts.push(t),
    client: () => `mac-${id}`,
    missed: (m) => missed.push(m),
  });
  return { id, store, room, calls, inbox, signals, missed, toasts, clock, view: () => view };
}

describe('calls in a room (BLG-716)', () => {
  it('ring, join and setup go through the room to one person at a time; guests are left out', () => {
    const everyone = [
      { peerId: 'ann', name: 'ann' },
      { peerId: 'bo', name: 'bo' },
      { peerId: 'gus', name: 'gus', guest: true },
    ];
    const ann = person('ann', everyone);
    const bo = person('bo', everyone);
    const gus = person('gus', everyone);
    const all = [ann, bo, gus];
    // The hub: each one's frames reach the others' call services.
    for (const p of all) for (const q of all) if (p !== q) p.inbox[q.id] = (from, payload) => q.room.receive(from, payload);

    ann.calls.start(ROOM_CONVERSATION);
    expect(bo.view()[ROOM_CONVERSATION]?.mine).toBe('ringing');
    // A guest (in with a project link) isn't in the room's chat: no ring for them.
    expect(gus.view()[ROOM_CONVERSATION]).toBeUndefined();

    bo.calls.join(ROOM_CONVERSATION);
    expect(ann.view()[ROOM_CONVERSATION]?.people.map((p) => p.name).sort()).toEqual(['You', 'bo']);
    expect(ann.calls.signal(ROOM_CONVERSATION, 'bo', '{"sdp":1}')).toBe(true);
    expect(bo.signals).toEqual(['{"sdp":1}']);

    // Someone who left the room is out of its call.
    bo.store.dispatch({ type: 'peers', peers: everyone.filter((p) => p.peerId !== 'ann').map((p) => ({ ...p, shares: [], agent: true })) });
    expect(bo.view()[ROOM_CONVERSATION]?.people.map((p) => p.peerId)).toEqual(['bo']);
    for (const p of all) p.calls.stop();
  });
});

describe('calls nobody can take, and calls you missed', () => {
  const everyone = [
    { peerId: 'ann', name: 'ann' },
    { peerId: 'bo', name: 'bo' },
  ];
  /** Ann and Bo in a room; `linked`: the hub carries their frames. */
  function pair(linked = true) {
    const ann = person('ann', everyone);
    const bo = person('bo', everyone);
    if (linked) {
      ann.inbox['bo'] = (from, p) => bo.room.receive(from, p);
      bo.inbox['ann'] = (from, p) => ann.room.receive(from, p);
    }
    return { ann, bo };
  }

  it('a call that would ring nobody doesn’t start', () => {
    const { ann } = pair(false);
    expect(() => ann.calls.start(ROOM_CONVERSATION)).toThrow(/can be reached right now/);
    expect(ann.view()[ROOM_CONVERSATION]).toBeUndefined();
    ann.calls.stop();
  });

  it('a ring nobody answers is missed: who rang, and when it rang here', () => {
    const { ann, bo } = pair();
    bo.clock.now = 2_000_000;
    ann.calls.start(ROOM_CONVERSATION);
    expect(bo.view()[ROOM_CONVERSATION]?.mine).toBe('ringing');
    bo.clock.now += RING_MS + 1;
    bo.calls.tick();
    expect(bo.view()[ROOM_CONVERSATION]?.mine).not.toBe('ringing');
    expect(bo.missed).toEqual([{ id: ann.view()[ROOM_CONVERSATION]!.id, conversation: ROOM_CONVERSATION, by: 'ann', name: 'ann', at: 2_000_000 }]);
    // Ringing longer doesn't miss it twice.
    bo.calls.tick();
    expect(bo.missed).toHaveLength(1);
    ann.calls.stop();
    bo.calls.stop();
  });

  it('the caller hanging up before you answer is missed too', () => {
    const { ann, bo } = pair();
    ann.calls.start(ROOM_CONVERSATION);
    ann.calls.leave(ROOM_CONVERSATION);
    expect(bo.view()[ROOM_CONVERSATION]).toBeUndefined();
    expect(bo.missed.map((m) => m.by)).toEqual(['ann']);
    ann.calls.stop();
    bo.calls.stop();
  });

  it('answered or declined isn’t missed', () => {
    const { ann, bo } = pair();
    ann.calls.start(ROOM_CONVERSATION);
    bo.calls.decline(ROOM_CONVERSATION);
    ann.calls.leave(ROOM_CONVERSATION);
    ann.calls.start(ROOM_CONVERSATION);
    bo.calls.join(ROOM_CONVERSATION);
    bo.calls.leave(ROOM_CONVERSATION);
    expect(bo.missed).toEqual([]);
    ann.calls.stop();
    bo.calls.stop();
  });
});
