import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateIdentity } from '../../src/net/crypto.js';
import { type NetworkService, attachNetwork, startNetwork } from '../../src/core/network.js';
import { Store, initialState } from '../../src/core/store.js';
import type { Session } from '../../src/core/session.js';
import { HANDLERS } from '../../src/ipc/handlers.js';
import { parseArgs } from '../../src/ipc/api.js';
import type { Reaction } from '../../src/shared/reactions.js';
import { dmConversation, groupConversation } from '../../src/net/mesh/views.js';
import { type Crowd, FAST, type Person, befriend, crowd, settle, texts } from './helpers.js';

// Emoji reactions travelling between Macs (BLG-702): direct messages over the link, groups in the log.

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

const id = (p: Person): string => p.identity.peerId;
const chipsOf = (p: Person, conversation: string, messageId: string): readonly Reaction[] | undefined => p.mesh.conversation(conversation).find((m) => m.id === messageId)?.reactions;

describe('reactions between Macs', () => {
  it('in a direct conversation: live both ways, toggled, and caught up after being offline', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    await befriend(ann, bob);
    const heard: Array<[string, string, readonly Reaction[]]> = [];
    bob.mesh.on('reacted', (c, m, r) => heard.push([c, m, r]));
    const sent = ann.mesh.sendDm(id(bob), 'lunch at 12?');
    await settle(() => bob.mesh.dmHistory(id(ann)).length === 1);
    const atAnn = dmConversation(id(ann));
    const atBob = dmConversation(id(bob));

    expect(bob.mesh.react(atAnn, sent.id, '👍')).toEqual([{ emoji: '👍', by: [id(bob)] }]);
    await settle(() => chipsOf(ann, atBob, sent.id)?.length === 1);
    expect(chipsOf(ann, atBob, sent.id)).toEqual([{ emoji: '👍', by: [id(bob)] }]);
    expect(heard.at(-1)).toEqual([atAnn, sent.id, [{ emoji: '👍', by: [id(bob)] }]]);
    // A reaction is no message: nothing unread for ann.
    expect(ann.friend(id(bob))?.unread).toBe(0);

    ann.mesh.react(atBob, sent.id, '👍');
    await settle(() => chipsOf(bob, atAnn, sent.id)?.[0]?.by.length === 2);
    // Clicking again takes yours off.
    bob.mesh.react(atAnn, sent.id, '👍');
    await settle(() => chipsOf(ann, atBob, sent.id)?.[0]?.by.length === 1);
    expect(chipsOf(ann, atBob, sent.id)).toEqual([{ emoji: '👍', by: [id(ann)] }]);

    // Bob is away: his reaction waits, and arrives when he's back.
    await ann.stop();
    await settle(() => bob.friend(id(ann))?.online === false);
    bob.mesh.react(atAnn, sent.id, '🎉', true);
    await ann.start();
    await settle(() => chipsOf(ann, atBob, sent.id)?.length === 2);
    expect(chipsOf(ann, atBob, sent.id)?.map((r) => r.emoji)).toEqual(['👍', '🎉']);
    // Kept with the history: the same after a restart.
    await bob.stop();
    await bob.start();
    expect(chipsOf(bob, atAnn, sent.id)?.map((r) => r.emoji)).toEqual(['👍', '🎉']);

    expect(() => bob.mesh.react(atAnn, 'no-such-message', '👍')).toThrow(/No such message/);
    expect(() => bob.mesh.react(atAnn, sent.id, 'lol')).toThrow(/emoji/);
  }, 90_000);

  it('in a group: everyone sees them, they persist, and they never show as messages', async () => {
    const [cat, dan, eve] = await Promise.all(['cat', 'dan', 'eve'].map((n) => net.add(n))) as [Person, Person, Person];
    await befriend(cat, dan);
    await befriend(cat, eve);
    const group = cat.mesh.createGroup('launch', [id(dan), id(eve)]);
    for (const p of [dan, eve]) await settle(() => p.group(group.id)?.active);
    const conv = groupConversation(group.id);
    const hello = cat.mesh.sendGroup(group.id, 'Morning! Staging is green.');
    for (const p of [dan, eve]) await settle(() => texts(p, group.id).length === 1);

    dan.mesh.react(conv, hello.id, '🎉');
    eve.mesh.react(conv, hello.id, '🎉');
    eve.mesh.react(conv, hello.id, '👀');
    for (const p of [cat, dan, eve]) await settle(() => chipsOf(p, conv, hello.id)?.length === 2 && chipsOf(p, conv, hello.id)?.[0]?.by.length === 2);
    for (const p of [cat, dan, eve]) expect(chipsOf(p, conv, hello.id)?.map((r) => r.emoji)).toEqual(['🎉', '👀']);
    // Only the message itself is in the history, and nothing extra is unread.
    for (const p of [cat, dan, eve]) expect(texts(p, group.id)).toEqual(['Morning! Staging is green.']);
    expect(cat.group(group.id)?.unread).toBe(0);
    expect(cat.group(group.id)?.last?.id).toBe(hello.id);

    eve.mesh.react(conv, hello.id, '🎉', false);
    await settle(() => chipsOf(cat, conv, hello.id)?.[0]?.by.length === 1);
    expect(chipsOf(cat, conv, hello.id)).toEqual([
      { emoji: '🎉', by: [id(dan)] },
      { emoji: '👀', by: [id(eve)] },
    ]);
    await cat.stop();
    await cat.start();
    expect(chipsOf(cat, conv, hello.id)?.map((r) => r.emoji)).toEqual(['🎉', '👀']);
  }, 90_000);
});

describe('network.messages.react through the API', () => {
  const services: NetworkService[] = [];
  afterAll(async () => {
    for (const s of services) await s.stop();
  });
  const daemon = async (name: string): Promise<{ store: Store; session: Session; service: NetworkService }> => {
    const store = new Store(initialState('room'));
    const service = await startNetwork({ store, identity: generateIdentity(), name, dir: mkdtempSync(path.join(os.tmpdir(), `klaud-react-${name}-`)), bootstrap: net.testnet.bootstrap, host: '127.0.0.1', timing: FAST });
    services.push(service);
    const session = {} as Session;
    attachNetwork(session, service);
    return { store, session, service };
  };
  const call = (session: Session, method: keyof typeof HANDLERS, ...args: unknown[]): unknown => (HANDLERS[method] as (s: Session, ...a: unknown[]) => unknown)(session, ...(parseArgs(method, args) as unknown[]));

  it("puts the chips in both Macs' shared state", async () => {
    const ann = await daemon('ann');
    const bob = await daemon('bob');
    const invite = await ann.service.mesh.createInvite();
    await bob.service.mesh.accept(invite.link);
    await settle(() => ann.store.getState().network.friends[0]?.online && bob.store.getState().network.friends[0]?.online);
    const sent = ann.service.mesh.sendDm(bob.service.mesh.peerId, 'ship it?');
    const atBob = dmConversation(ann.service.mesh.peerId);
    await settle(() => bob.store.getState().network.messages[atBob]?.length === 1);
    expect(call(bob.session, 'network.messages.react', atBob, sent.id, '✅')).toEqual([{ emoji: '✅', by: [bob.service.mesh.peerId] }]);
    expect(bob.store.getState().network.messages[atBob]?.[0]?.reactions).toEqual([{ emoji: '✅', by: [bob.service.mesh.peerId] }]);
    const atAnn = dmConversation(bob.service.mesh.peerId);
    await settle(() => ann.store.getState().network.messages[atAnn]?.[0]?.reactions?.length === 1);
    expect(() => call(bob.session, 'network.messages.react', atBob, sent.id, 'nope')).toThrow();
  }, 60_000);
});
