import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { generateIdentity } from '../../src/net/crypto.js';
import { KEEP_MESSAGES, NO_NETWORK, initialNetwork, reduceNetwork } from '../../src/core/network-store.js';
import { type NetworkService, attachNetwork, launchNetwork, networkEnabled, networkOf, networkSwitch, networkSwitchOf, startNetwork } from '../../src/core/network.js';
import { Store, initialState } from '../../src/core/store.js';
import type { Session } from '../../src/core/session.js';
import { HANDLERS } from '../../src/ipc/handlers.js';
import { parseArgs } from '../../src/ipc/api.js';
import type { MessageView } from '../../src/net/mesh/views.js';
import { FAST, LOSES_A_MESSAGE_ON_WINDOWS, settle } from './helpers.js';

let testnet: Testnet;
const services: NetworkService[] = [];
beforeAll(async () => {
  testnet = await createTestnet(3, { host: '127.0.0.1' });
}, 30_000);
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
});
afterAll(async () => {
  await testnet?.destroy();
});

/** A daemon's worth of network: a store, the service, and a session object the API handlers use. */
async function person(name: string): Promise<{ store: Store; service: NetworkService; session: Session; dir: string }> {
  const store = new Store(initialState('room'));
  const dir = mkdtempSync(path.join(os.tmpdir(), `klaud-net-${name}-`));
  const service = await startNetwork({ store, identity: generateIdentity(), name, dir, bootstrap: testnet.bootstrap, host: '127.0.0.1', timing: FAST });
  services.push(service);
  const session = { store } as unknown as Session;
  attachNetwork(session, service);
  return { store, service, session, dir };
}

/** Call an API method the way the daemon does: check the arguments, then run the handler. */
const call = async (session: Session, method: keyof typeof HANDLERS, ...args: unknown[]): Promise<unknown> => {
  const parsed = parseArgs(method, args) as unknown[];
  return (HANDLERS[method] as (s: Session, ...a: unknown[]) => unknown)(session, ...parsed);
};

describe('the network as a core service', () => {
  // Windows' runners now and then never see the two come online (a link lost while both dial, BLG-728): skipped
  // there like the other network tests that wait on it (tests/mesh/helpers.ts); macOS and Linux still run it.
  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('mirrors friends, presence, groups and messages into the shared state, through the API', async () => {
    const ann = await person('ann');
    const bob = await person('bob');
    expect(await call(ann.session, 'network.status')).toMatchObject({ enabled: true, peerId: ann.service.mesh.peerId });
    const invite = (await call(ann.session, 'network.friends.invite')) as { code: string; link: string };
    await settle(() => ann.store.getState().network.invitations.length === 1);
    await call(bob.session, 'network.friends.accept', invite.code);
    await settle(() => ann.store.getState().network.friends[0]?.online && bob.store.getState().network.friends[0]?.online);
    expect(ann.store.getState().network).toMatchObject({ enabled: true, self: { name: 'ann' }, invitations: [] });

    await call(bob.session, 'network.presence.set', { state: 'dnd', note: 'focus', emoji: '🎧' });
    await settle(() => ann.store.getState().network.friends[0]?.presence.state === 'dnd');
    expect(await call(bob.session, 'network.presence.get')).toEqual({ state: 'dnd', note: 'focus', emoji: '🎧' });
    expect(ann.store.getState().network.friends[0]?.presence).toEqual({ state: 'dnd', note: 'focus', emoji: '🎧' });

    const bobId = bob.service.mesh.peerId;
    await call(ann.session, 'network.dm.send', bobId, 'hello bob');
    const conv = `dm:${ann.service.mesh.peerId}`;
    await settle(() => bob.store.getState().network.messages[conv]?.some((m) => m.text === 'hello bob'));
    await settle(() => ann.store.getState().network.messages[`dm:${bobId}`]?.at(-1)?.status === 'delivered');
    expect(bob.store.getState().network.friends[0]?.unread).toBe(1);
    // A screen showing the conversation reads it.
    bob.store.dispatch({ type: 'attention', attention: { shown: [conv], visible: [conv], files: false, front: true } });
    await settle(() => bob.store.getState().network.friends[0]?.unread === 0);

    const group = (await call(ann.session, 'network.groups.create', 'pair', [bobId])) as { id: string };
    await settle(() => bob.store.getState().network.groups[0]?.id === group.id);
    await call(bob.session, 'network.groups.send', group.id, 'in the group');
    await settle(() => ann.store.getState().network.groups[0]?.last?.text === 'in the group');
    expect(((await call(ann.session, 'network.groups.history', group.id, { limit: 10 })) as MessageView[]).map((m) => m.text)).toEqual(['in the group']);
    expect(await call(ann.session, 'network.groups.list')).toHaveLength(1);
    await call(ann.session, 'network.read', `group:${group.id}`);
    await settle(() => ann.store.getState().network.groups[0]?.unread === 0);

    // Nothing secret ever reaches the shared state: no keys, cards or signatures.
    const shared = JSON.stringify(ann.store.getState().network);
    expect(shared).not.toMatch(/PRIVATE KEY|"sig"|"box"|"secretKey"|"card"/);
    expect(shared).not.toContain(ann.service.mesh.address);
  }, 60_000);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('says Seen only for a chat on a screen in front, or opened on the phone, and never when you turned it off (BLG-798)', async () => {
    const ann = await person('ann');
    const bob = await person('bob');
    const invite = (await call(ann.session, 'network.friends.invite')) as { code: string };
    await call(bob.session, 'network.friends.accept', invite.code);
    await settle(() => ann.store.getState().network.friends[0]?.online && bob.store.getState().network.friends[0]?.online);
    const bobId = bob.service.mesh.peerId;
    const conv = `dm:${ann.service.mesh.peerId}`;
    const last = (): string | undefined => ann.store.getState().network.messages[`dm:${bobId}`]?.at(-1)?.status;
    const send = async (text: string): Promise<void> => {
      await call(ann.session, 'network.dm.send', bobId, text);
      await settle(() => bob.store.getState().network.messages[conv]?.some((m) => m.text === text));
      await settle(() => last() === 'delivered');
    };
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

    // Shown behind other windows: read, not Seen.
    await send('one');
    bob.store.dispatch({ type: 'attention', attention: { shown: [conv], visible: [conv], files: false, front: false } });
    await wait();
    expect(last()).toBe('delivered');
    // In front: Seen.
    bob.store.dispatch({ type: 'attention', attention: { shown: [conv], visible: [conv], files: false, front: true } });
    await settle(() => last() === 'seen');

    // Turned off: in front, still only Delivered; the phone opening it neither.
    bob.store.dispatch({ type: 'attention', attention: { shown: [], visible: [], files: false, front: true } });
    bob.store.dispatch({ type: 'prefs', prefs: { readReceipts: false } });
    await send('two');
    bob.store.dispatch({ type: 'attention', attention: { shown: [conv], visible: [conv], files: false, front: true } });
    await call(bob.session, 'network.read', conv);
    await wait();
    expect(last()).toBe('delivered');

    // On again: the phone opening the chat says it.
    bob.store.dispatch({ type: 'attention', attention: { shown: [], visible: [], files: false, front: false } });
    bob.store.dispatch({ type: 'prefs', prefs: { readReceipts: true } });
    await send('three');
    await call(bob.session, 'network.read', conv);
    await settle(() => last() === 'seen');
  }, 60_000);

  it('refuses bad arguments, and says clearly when the network is off', async () => {
    const off = {} as Session;
    await expect(call(off, 'network.friends.list')).rejects.toThrow(/network is off/);
    expect(await call(off, 'network.status')).toEqual({ enabled: false });
    expect(() => networkOf(off)).toThrow(/network is off/);
    expect(() => parseArgs('network.dm.send', ['not-a-peer', 'x'])).toThrow(/Bad arguments/);
    expect(() => parseArgs('network.read', ['room'])).toThrow(/Bad arguments/);
    expect(() => parseArgs('network.presence.set', [{ state: 'busy' }])).toThrow(/Bad arguments/);
  });

  it('runs once per computer, and only when turned on', async () => {
    const ann = await person('ann2');
    await expect(startNetwork({ store: ann.store, identity: generateIdentity(), name: 'x', dir: ann.dir, bootstrap: testnet.bootstrap, host: '127.0.0.1' })).rejects.toThrow(/already on the network/);
    const before = process.env.KLAUD_NETWORK;
    try {
      delete process.env.KLAUD_NETWORK;
      expect(networkEnabled({})).toBe(false);
      expect(networkEnabled({ network: true })).toBe(true);
      process.env.KLAUD_NETWORK = '1';
      expect(networkEnabled({})).toBe(true);
      process.env.KLAUD_NETWORK = '0';
      expect(networkEnabled({ network: true })).toBe(false);
      const stop = launchNetwork({ session: {}, store: ann.store, identity: generateIdentity(), name: 'x', dir: ann.dir, demo: false, warn: () => undefined }, { network: true });
      await stop();
    } finally {
      if (before === undefined) delete process.env.KLAUD_NETWORK;
      else process.env.KLAUD_NETWORK = before;
    }
  }, 30_000);

  it('the demo simulates friends and a group on a private network', async () => {
    const store = new Store(initialState('room'));
    const session = {} as Session;
    const warnings: string[] = [];
    const before = process.env.KLAUD_NETWORK;
    process.env.KLAUD_NETWORK = '1';
    try {
      const stop = launchNetwork({ session, store, identity: generateIdentity(), name: 'you', dir: '/nonexistent', demo: true, warn: (t) => warnings.push(t) }, {});
      await settle(() => store.getState().network.friends.length === 2 && store.getState().network.groups.length === 1);
      await settle(() => store.getState().network.groups[0]?.last && store.getState().network.friends.some((f) => f.last));
      const bob = store.getState().network.friends.find((f) => f.name === 'bob')!;
      networkOf(session).sendDm(bob.peerId, 'ping');
      await settle(() => store.getState().network.messages[`dm:${bob.peerId}`]?.some((m) => m.text.startsWith('On it')));
      await stop();
      expect(store.getState().network).toEqual(NO_NETWORK);
      expect(warnings).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.KLAUD_NETWORK;
      else process.env.KLAUD_NETWORK = before;
    }
  }, 60_000);
});

describe('turning the network on and off while Beluga runs', () => {
  // Not on Windows: chmod can’t make a folder unwritable on Windows.
  it.skipIf(process.platform === 'win32')('starts it live, stops it, and says why when it can’t start', async () => {
    const before = process.env.KLAUD_NETWORK;
    delete process.env.KLAUD_NETWORK;
    try {
      const store = new Store(initialState('room'));
      const session = {} as Session;
      const sw = networkSwitch({ session, store, identity: generateIdentity(), name: 'you', dir: '/nonexistent', demo: true, warn: () => undefined }, {});
      expect(networkSwitchOf(session)).toBe(sw);
      await expect(call({} as Session, 'network.setEnabled', true)).rejects.toThrow(/Only the Beluga app/);
      expect(() => networkOf(session)).toThrow(/off/);
      await sw.set(true);
      await settle(() => store.getState().network.friends.length === 2);
      expect(networkOf(session).peerId).toBe(store.getState().network.self?.peerId);
      // Asking again while it's on changes nothing.
      await sw.set(true);
      await sw.set(false);
      expect(store.getState().network).toEqual(NO_NETWORK);
      expect(() => networkOf(session)).toThrow(/off/);
      await sw.stop();
      expect(networkSwitchOf(session)).toBeUndefined();

      // A real network with nowhere to keep its files: the error comes back to whoever turned it on.
      const broken = networkSwitch({ session: {}, store, identity: generateIdentity(), name: 'x', dir: '/dev/null/klaud', demo: false, warn: () => undefined }, {});
      await expect(broken.set(true)).rejects.toThrow();
      await broken.stop();
    } finally {
      if (before === undefined) delete process.env.KLAUD_NETWORK;
      else process.env.KLAUD_NETWORK = before;
    }
  }, 60_000);
});

describe('network state reducer', () => {
  const msg = (id: string, text = id): MessageView => ({ id, conversation: 'dm:x', from: 'x', name: 'x', text, ts: 1, mine: false });

  it('appends messages, replaces by id (status changes), and keeps the latest', () => {
    let s = initialNetwork;
    s = reduceNetwork(s, { type: 'net_message', message: msg('a') });
    s = reduceNetwork(s, { type: 'net_message', message: { ...msg('a'), status: 'delivered' } });
    expect(s.network.messages['dm:x']).toEqual([{ ...msg('a'), status: 'delivered' }]);
    for (let i = 0; i < KEEP_MESSAGES + 5; i++) s = reduceNetwork(s, { type: 'net_message', message: msg(`m${i}`) });
    expect(s.network.messages['dm:x']).toHaveLength(KEEP_MESSAGES);
    expect(s.network.messages['dm:x']?.at(-1)?.id).toBe(`m${KEEP_MESSAGES + 4}`);
    const summary = { enabled: true, friends: [], groups: [], invitations: [], pendingJoins: [] };
    s = reduceNetwork(s, { type: 'net_summary', summary });
    expect(s.network.messages['dm:x']).toHaveLength(KEEP_MESSAGES);
    expect(reduceNetwork(s, { type: 'net_off' }).network).toEqual(NO_NETWORK);
  });
});
