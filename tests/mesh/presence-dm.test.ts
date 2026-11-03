import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dmConversation } from '../../src/net/mesh/views.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

describe('presence', () => {
  it('friends see your status and note; appearing offline hides you but keeps you reachable', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    await befriend(ann, bob);
    expect(bob.friend(ann.identity.peerId)?.presence.state).toBe('online');

    ann.mesh.setPresence({ state: 'away', note: 'lunch' });
    await settle(() => bob.friend(ann.identity.peerId)?.presence.state === 'away');
    expect(bob.friend(ann.identity.peerId)).toMatchObject({ online: true, presence: { state: 'away', note: 'lunch' } });

    ann.mesh.setPresence({ state: 'dnd' });
    await settle(() => bob.friend(ann.identity.peerId)?.presence.state === 'dnd');

    ann.mesh.setPresence({ state: 'offline', note: 'secret note', emoji: '🤫' });
    await settle(() => bob.friend(ann.identity.peerId)?.online === false);
    // Others see a plain "offline" (not your note); you still see what you chose.
    expect(bob.friend(ann.identity.peerId)?.presence).toEqual({ state: 'offline' });
    expect(ann.mesh.summary().self).toMatchObject({ appearOffline: true, presence: { state: 'offline' } });
    // …and messages still reach you.
    bob.mesh.sendDm(ann.identity.peerId, 'are you there?');
    await settle(() => ann.mesh.dmHistory(bob.identity.peerId).some((m) => m.text === 'are you there?'));
    await settle(() => bob.mesh.dmHistory(ann.identity.peerId).at(-1)?.status === 'delivered');

    // A status with an end time goes back to online by itself; it survives a restart before that.
    ann.mesh.setPresence({ state: 'away', until: Date.now() + 400 });
    await ann.stop();
    await ann.start();
    expect(ann.mesh.getPresence().state).toBe('away');
    await settle(() => bob.friend(ann.identity.peerId)?.presence.state === 'away');
    await settle(() => bob.friend(ann.identity.peerId)?.presence.state === 'online');
  }, 60_000);
});

describe('direct messages', () => {
  it('wait in the outbox for an offline friend and arrive when they come back', async () => {
    const cat = await net.add('cat');
    const dan = await net.add('dan');
    await befriend(cat, dan);
    await dan.stop();
    await settle(() => cat.friend(dan.identity.peerId)?.online === false);
    const sent = cat.mesh.sendDm(dan.identity.peerId, 'see this when you are back');
    expect(sent).toMatchObject({ mine: true, status: 'waiting', conversation: dmConversation(dan.identity.peerId) });
    cat.mesh.sendDm(dan.identity.peerId, 'and this');
    // Even across a restart of the sender.
    await cat.stop();
    await cat.start();
    await dan.start();
    await settle(() => dan.mesh.dmHistory(cat.identity.peerId).length === 2);
    expect(dan.mesh.dmHistory(cat.identity.peerId).map((m) => m.text)).toEqual(['see this when you are back', 'and this']);
    await settle(() => cat.mesh.dmHistory(dan.identity.peerId).every((m) => m.status === 'delivered'));
    // Unread until read.
    expect(dan.friend(cat.identity.peerId)?.unread).toBe(2);
    dan.mesh.markRead(dmConversation(cat.identity.peerId));
    expect(dan.friend(cat.identity.peerId)?.unread).toBe(0);
    expect(dan.friend(cat.identity.peerId)?.last?.text).toBe('and this');
    // Delivered once, even though both sides reconnect again.
    await dan.stop();
    await dan.start();
    await settle(() => dan.friend(cat.identity.peerId)?.online);
    expect(dan.mesh.dmHistory(cat.identity.peerId)).toHaveLength(2);
  }, 60_000);

  it('go through a mutual friend when there is no direct route (relayed, still end to end)', async () => {
    const blocked = new Set<string>();
    const isBlocked = (peerId: string): boolean => blocked.has(peerId);
    const eve = await net.add('eve', { blocked: isBlocked });
    const fay = await net.add('fay', { blocked: isBlocked });
    const gus = await net.add('gus');
    blocked.add(eve.identity.peerId).add(fay.identity.peerId);
    await befriend(eve, gus);
    await befriend(fay, gus);
    // eve and fay become friends: pairing works (it's its own connection), the link is relayed by gus.
    const invite = await eve.mesh.createInvite();
    await fay.mesh.accept(invite.code);
    await settle(() => eve.friend(fay.identity.peerId)?.online && fay.friend(eve.identity.peerId)?.online);
    expect(eve.friend(fay.identity.peerId)?.via).toBe('relay');
    fay.mesh.sendDm(eve.identity.peerId, 'through gus');
    await settle(() => eve.mesh.dmHistory(fay.identity.peerId).some((m) => m.text === 'through gus'));
    // gus relays but isn't their friend-in-common for reading: the message isn't in his history.
    expect(gus.mesh.dmHistory(eve.identity.peerId)).toEqual([]);
    // When gus goes away, the relayed link drops; when he's back it comes up again.
    await gus.stop();
    await settle(() => eve.friend(fay.identity.peerId)?.online === false);
    await gus.start();
    await settle(() => eve.friend(fay.identity.peerId)?.online);
  }, 60_000);
});
