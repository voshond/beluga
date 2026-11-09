import { describe, expect, it } from 'vitest';
import { ComputerWork } from '../packages/companion/lib/link/computer-work.js';
import { mergeNeeds, needRoute, placeNeeds } from '../packages/companion/lib/link/needs.js';
import { chatTopic } from '../src/companion/needs-you.js';
import { COMPANION_PROTO, type NeedsYou, type PhoneFrame } from '../src/companion/protocol.js';
import { type FriendsMessages, newMessages } from '../src/companion/push.js';

/** A friend's new message becomes one notification on its chat (BLG-850): src/companion/push.ts. */

const msg = (id: string, over: Partial<FriendsMessages['messages'][string][number]> = {}) => ({ id, name: 'Mia', text: `hi ${id}`, ts: 100, mine: false, ...over });
const base: FriendsMessages = { messages: {}, friends: [{ peerId: 'mia', name: 'Mia' }], groups: [{ id: 'g1', name: 'Design' }] };

describe('friends’ new messages as notifications', () => {
  it('says a new direct message with the friend’s name, and a group’s with who said it', () => {
    const next: FriendsMessages = { ...base, messages: { 'dm:mia': [msg('1')], 'group:g1': [msg('2', { name: 'Bob', text: 'look at this' })] } };
    expect(newMessages(base, next, 0, chatTopic)).toEqual([
      { kind: 'mentions', title: 'Mia', body: 'hi 1', topic: 'chat:dm:mia', priority: 'normal', collapse: 'chat:dm:mia', friends: true },
      { kind: 'mentions', title: 'Design', body: 'Bob: look at this', topic: 'chat:group:g1', priority: 'normal', collapse: 'chat:group:g1', friends: true },
    ]);
  });

  it('never tells your own, what was there, what came before it started, or what can’t be read', () => {
    const prev: FriendsMessages = { ...base, messages: { 'dm:mia': [msg('1')] } };
    const next: FriendsMessages = { ...base, messages: { 'dm:mia': [msg('1'), msg('2', { mine: true }), msg('3', { ts: 10 }), msg('4', { status: 'locked' })] } };
    expect(newMessages(prev, next, 50, chatTopic)).toEqual([]);
    // The same list again: nothing.
    expect(newMessages(next, next, 0, chatTopic)).toEqual([]);
  });

  it('says several at once as one, the newest, with how many more', () => {
    const next: FriendsMessages = { ...base, messages: { 'dm:mia': [msg('1'), msg('2'), msg('3', { text: 'and ```code``` here' })] } };
    expect(newMessages(base, next, 0, chatTopic)[0]?.body).toBe('and (code) here (+2)');
  });
});

/** A friend's request, as the Mac (its cached home) and your Always On both list it (src/companion/needs-you.ts). */
const AO = 'a0a0a0a0a0a0a0a0';
const request: NeedsYou = {
  id: 'request:t1',
  kind: 'request',
  title: 'Mia: run the tests',
  from: 'Mia',
  askedAt: 1,
  actions: [
    { label: 'Approve', tone: 'main', method: 'gateway.decide', args: ['t1', { answer: 'yes' }] },
    { label: 'Decline', tone: 'danger', method: 'gateway.decide', args: ['t1', { answer: 'no' }] },
  ],
} as NeedsYou;
const mine: NeedsYou = { ...request, id: 'approval:a1', title: 'Run npm test?', actions: [] } as NeedsYou;

describe('friends’ requests with your Mac closed (BLG-857)', () => {
  it('lists each once: the Mac’s copy while its link is open, your Always On’s while it’s closed', () => {
    const theirs = placeNeeds(AO, 'mini', [request]);
    expect(theirs[0]).toMatchObject({ id: `${AO}|request:t1`, from: 'mini · Mia' });
    // Open: nothing changes, the Mac's copy answers.
    expect(mergeNeeds([mine, request], theirs, true).map((n) => n.id)).toEqual(['approval:a1', 'request:t1']);
    // Closed: the Always On's copy, and the Mac's own items stay.
    expect(mergeNeeds([mine, request], theirs, false).map((n) => n.id)).toEqual(['approval:a1', `${AO}|request:t1`]);
    expect(needRoute('approval:a1')).toBeUndefined();
  });

  it('a gateway.* request answered with the Mac closed goes to your Always On, not the Mac’s outbox', async () => {
    const sent: Array<{ id: string; frame: PhoneFrame }> = [];
    const work = new ComputerWork({
      send: (id, frame) => (sent.push({ id, frame }), id === AO),
      proto: () => ({ ...COMPANION_PROTO }),
      name: () => 'mini',
      emit: () => undefined,
    });
    const shown = mergeNeeds([request], placeNeeds(AO, 'mini', [request]), false);
    const item = shown.find((n) => n.kind === 'request')!;
    const action = item.actions.find((a) => a.tone === 'main')!;
    // As store.answer does: the item's id says which computer, and the call goes over its link.
    const route = needRoute(item.id)!;
    expect(route).toEqual({ on: AO, id: 'request:t1' });
    const answered = work.call(route.on, action.method, action.args);
    const asked = sent.at(-1)!;
    expect(asked).toMatchObject({ id: AO, frame: { t: 'call', method: 'gateway.decide', args: ['t1', { answer: 'yes' }] } });
    work.take(AO, { t: 'result', id: (asked.frame as Extract<PhoneFrame, { t: 'call' }>).id, ok: true, value: { decided: true } });
    await expect(answered).resolves.toEqual({ decided: true });
  });
});
