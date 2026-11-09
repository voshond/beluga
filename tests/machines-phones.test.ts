import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CompanionClient, pairDevice } from '../src/companion/client.js';
import { deviceKeys, newSeed } from '../src/companion/device-crypto.js';
import { DeviceBook, deviceId } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { type DeviceCert, type MacFrame, PhoneComputer } from '../src/companion/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import type { MachineRecord } from '../src/machines/book.js';
import { Machines } from '../src/machines/machines.js';
import { computersKey, namedPhones, phoneComputers, runsOnWords, setPhoneRecord } from '../src/machines/phones.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * Your phone reaches your computers by itself (BLG-809): your Mac tells it where each one is, and
 * each computer lets in the phones of your device set with the phone's limits. With the Mac off,
 * the phone still links to each computer, and a computer added later shows up without pairing again.
 */

const hex = (c: string, n = 64): string => c.repeat(n);
const cert = (over: Partial<DeviceCert>): DeviceCert => ({ v: 1, owner: 'me', ownerKey: 'k', device: hex('a'), link: hex('b'), box: hex('c'), name: 'x', platform: 'linux', issuedAt: 1, sig: 's', ...over });
const record = (over: Partial<MachineRecord> & { cert: DeviceCert }): MachineRecord => ({ address: hex('f'), relays: [], name: 'mini', pairedAt: 1, ...over });

describe('what a phone hears of your computers', () => {
  it('lists only computers, with where to dial each, their look as last heard, and your Always On', () => {
    const mini = cert({ device: hex('1'), role: 'computer' });
    const app = cert({ device: hex('2'), role: 'app', platform: 'macos' });
    const list = phoneComputers(
      [record({ cert: mini, relays: ['wss://relay.example/r/1'], icon: 'server', lastSeen: 50 }), record({ cert: app, name: 'MacBook' })],
      { alwaysOn: deviceId(mini), look: () => ({ name: 'Mac mini' }) },
    );
    expect(list).toEqual([{ id: deviceId(mini), name: 'Mac mini', icon: 'server', platform: 'linux', address: hex('f'), relays: ['wss://relay.example/r/1'], lastSeen: 50, alwaysOn: true }]);
  });

  it('says what kind each is and which Linux, so the phone draws the Mac’s mark', () => {
    const box = cert({ device: hex('1'), role: 'computer' });
    const [one] = phoneComputers([record({ cert: box })], { look: () => ({ kind: 'linux', distro: 'ubuntu' }) });
    expect(one).toMatchObject({ kind: 'linux', distro: 'ubuntu' });
    expect(PhoneComputer.parse(one)).toMatchObject({ kind: 'linux', distro: 'ubuntu' });
  });

  it('says each one’s Runs on line as the Mac’s menu does, but leaves whether it answers to the phone', () => {
    const view = { id: '1'.repeat(16), name: 'aws', platform: 'linux' as const, pairedAt: 1, skew: 'same' as never, kind: 'aws' as const, lastSeen: 5 };
    const info = { at: 1, cpus: 4, loadPerCore: 0.2, memory: { freeGB: 12.4, totalGB: 16 }, agentsRunning: 1, runtimes: [{ id: 'claude', state: 'ready' as const }], gh: 'signed_in' as const, mcp: [], projects: [] };
    expect(runsOnWords({ ...view, status: 'offline', info } as never, 'claude')).toEqual({ line: 'AWS · 12 GB free · 1 task running' });
    expect(runsOnWords({ ...view, status: 'online', info: { ...info, runtimes: [{ id: 'claude', state: 'signed_out' as const }] } } as never, 'claude')).toEqual({ line: 'AWS · 12 GB free · 1 task running', why: 'Claude isn’t signed in there' });
    // Never asked yet: nothing to say against it.
    expect(runsOnWords({ ...view, status: 'unknown' } as never, 'codex')).toEqual({ line: 'AWS' });
  });

  it('says the list again only when more than when each was last seen changed', () => {
    const one: PhoneComputer = { id: '1'.repeat(16), name: 'mini', platform: 'linux', address: hex('f'), relays: [], lastSeen: 1 };
    expect(computersKey([one])).toBe(computersKey([{ ...one, lastSeen: 99 }]));
    expect(computersKey([one])).not.toBe(computersKey([{ ...one, name: 'Mac mini' }]));
  });

  it('names the phones paired here first, then your set’s, never an app or a computer', () => {
    const here = cert({ link: hex('1') });
    const elsewhere = cert({ link: hex('2'), device: hex('9') });
    const computer = cert({ link: hex('3'), role: 'computer' });
    expect(namedPhones([here], [elsewhere, here, computer])).toEqual([hex('1', 16), hex('2', 16)]);
    expect(setPhoneRecord(computer)).toBeUndefined();
  });
});

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(async () => {
  testnet = await createTestnet(3);
}, 30_000);
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** One install as the daemon runs it: a companion host and its device set beside it. */
async function install(name: string, opts: { tellsFriends?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-phones-'));
  const identity = generateIdentity();
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  const calls: Array<{ client: string; method: string }> = [];
  let host!: CompanionHost;
  const machines = new Machines({
    dir,
    identity,
    devices,
    node: () => host.dhtNode(),
    address: () => host.address(),
    relayUrl: () => host.relayUrl(),
    relay: { add: (r) => host.reach.server.add(r), remove: (k) => host.reach.server.remove(k) },
    name: () => name,
    version: '0.9.0',
    platform: name === 'MacBook' ? 'macos' : 'linux',
    removePhone: (id) => void host.removeDevice(id),
    onChange: () => host.machinesChanged(),
    retryMs: 300,
    pollMs: 60_000,
  });
  host = new CompanionHost({
    identity,
    store,
    devices,
    call: async (client, method) => {
      calls.push({ client, method });
      return { ok: true, value: `${name} did ${method}` };
    },
    macName: () => name,
    version: '0.9.0',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' },
    coalesceMs: 50,
    machines,
    ...(opts.tellsFriends !== undefined ? { tellsFriends: () => opts.tellsFriends! } : {}),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await machines.stop();
    await host.stop();
  };
  cleanup.push(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  machines.start();
  return { dir, identity, host, machines, devices, store, calls, stop };
}
type Install = Awaited<ReturnType<typeof install>>;

async function join(app: Install, computer: Install) {
  const info = await computer.machines.pairStart();
  await app.machines.joinStart(info.link);
  await app.machines.joinApprove();
  await waitFor(() => computer.machines.pairStatus().last?.kind === 'joined', 10_000);
}

/** A phone paired with `app`, as the phone's worklet holds it: its DHT node, keys and certificate. */
async function pairPhone(app: Install) {
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  const keys = deviceKeys(newSeed());
  const info = await app.host.pairStart();
  const paired = pairDevice(node, info.link, { keys, name: 'Pixel 9', platform: 'android', app: '1.0.0' }, { timeoutMs: 20_000 });
  await waitFor(() => app.store.getState().companion.pairing?.waiting, 15_000);
  app.host.pairApprove();
  const result = await paired;
  return { node, keys, cert: result.cert, address: result.address };
}

type Phone = Awaited<ReturnType<typeof pairPhone>>;

function link(phone: Phone, address: string, computers?: PhoneComputer[][], nudges?: Array<{ from: string; nudge: Extract<MacFrame, { t: 'nudge' }> }>, from = '') {
  const client = new CompanionClient({ node: phone.node, address, link: phone.keys.link, app: '1.0.0', platform: 'android', topics: [] });
  const closes: number[] = [];
  client.on('close', (code) => closes.push(code));
  if (computers) client.on('computers', (f: Extract<MacFrame, { t: 'computers' }>) => computers.push(f.list));
  if (nudges) client.on('nudge', (nudge) => nudges.push({ from, nudge }));
  cleanup.push(() => client.close());
  return { client, closes };
}

describe('the phone reaches your computers by itself', () => {
  it('hears where they are from the Mac, links to one with the Mac off, with the phone’s limits, and a new one needs no pairing', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    await join(app, mini);
    const phone = await pairPhone(app);
    const phoneId = deviceId(phone.cert);
    // The phone joins your set, and the set reaches the computer: it lets that phone in, as a phone.
    await waitFor(() => mini.machines.phone(phone.cert.link), 15_000);
    expect(mini.machines.admit(phone.cert.link)).toBeUndefined();
    expect(mini.devices.size).toBe(0);

    // Linked to the Mac, the phone hears where your computers are.
    const heard: PhoneComputer[][] = [];
    const toMac = link(phone, phone.address, heard);
    await toMac.client.connect();
    const first = await waitFor(() => heard[0], 10_000);
    expect(first).toEqual([expect.objectContaining({ name: 'mini', platform: 'linux', address: mini.host.address() })]);

    // A computer added later shows up on the linked phone, without pairing it again.
    const aws = await install('aws');
    await join(app, aws);
    const both = await waitFor(() => heard.find((l) => l.length === 2), 15_000);
    expect(both.map((c) => c.name).sort()).toEqual(['aws', 'mini']);
    await waitFor(() => aws.machines.phone(phone.cert.link), 15_000);

    // The Mac goes off: the phone still reaches each computer, straight, with the certificate it has.
    toMac.client.close();
    await app.stop();
    const toMini = link(phone, mini.host.address());
    const welcome = await toMini.client.connect();
    expect(welcome.mac.name).toBe('mini');
    const toAws = link(phone, both.find((c) => c.name === 'aws')!.address);
    expect((await toAws.client.connect()).mac.name).toBe('aws');

    // The computer applies the phone's table: what a phone may goes through as the phone, the rest is refused.
    expect(await toMini.client.call('host.answerApproval', ['yes', 'a1'])).toBe('mini did host.answerApproval');
    expect(mini.calls).toEqual([{ client: `phone:${phoneId}`, method: 'host.answerApproval' }]);
    await expect(toMini.client.call('session.setPrefs', [{ theme: 'calm' }])).rejects.toThrow(/only on your Mac/);
    await expect(toMini.client.call('workspaces.merge', ['x'])).rejects.toThrow(/only on your Mac/);
    expect(mini.calls).toHaveLength(1);

    // A phone that isn't in your set is turned away.
    const stranger = { ...phone, keys: deviceKeys(newSeed()) };
    const err = await link(stranger, mini.host.address()).client.connect().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);

    // Forgotten on the computer: its link there drops at once.
    mini.machines.forget(phoneId);
    await waitFor(() => toMini.closes.length > 0, 5_000);
    expect(toMini.closes[0]).toBe(4010);
  }, 240_000);
});

describe('friends on the phone with your Mac closed', () => {
  it('a friend’s message notifies once, from your Always On, whether the Mac is open or not; the request is answered there', async () => {
    // Your Always On (mini) runs your friends network; the Mac only shows it (BLG-797).
    const app = await install('MacBook', { tellsFriends: false });
    const mini = await install('mini', { tellsFriends: true });
    await join(app, mini);
    const phone = await pairPhone(app);
    await waitFor(() => mini.machines.phone(phone.cert.link), 15_000);

    // The phone in the background (Stay connected): linked to both, showing nothing.
    const nudges: Array<{ from: string; nudge: Extract<MacFrame, { t: 'nudge' }> }> = [];
    const toMac = link(phone, phone.address, undefined, nudges, 'mac');
    const toMini = link(phone, mini.host.address(), undefined, nudges, 'mini');
    await toMac.client.connect();
    await toMini.client.connect();
    toMac.client.focus(false);
    toMini.client.focus(false);
    // Each side has a baseline before the message (what's there when a phone links isn't news).
    await new Promise((r) => setTimeout(r, 300));

    // The same message reaches both: the Always On's network, and the Mac's mirror of it.
    const message = { id: 'm1', conversation: 'dm:mia', from: 'mia', name: 'Mia', text: 'are you there?', ts: Date.now(), mine: false };
    for (const i of [mini, app]) i.store.dispatch({ type: 'net_message', message });
    await waitFor(() => nudges.length > 0, 5_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(nudges).toEqual([{ from: 'mini', nudge: { t: 'nudge', kind: 'mentions', title: 'Mia', body: 'are you there?', topic: 'chat:dm:mia' } }]);

    // The Mac closes: the next one still comes, from the Always On.
    toMac.client.close();
    await app.stop();
    mini.store.dispatch({ type: 'net_message', message: { ...message, id: 'm2', text: 'ping', ts: Date.now() } });
    await waitFor(() => nudges.length > 1, 5_000);
    expect(nudges[1]).toMatchObject({ from: 'mini', nudge: { kind: 'mentions', body: 'ping' } });

    // Reading and answering go to the Always On with the phone's limits.
    expect(await toMini.client.call('network.dm.send', ['mia', 'here'])).toBe('mini did network.dm.send');
    expect(await toMini.client.call('network.groups.approve', ['g1', 'bob'])).toBe('mini did network.groups.approve');
    await expect(toMini.client.call('network.groups.create', ['x'])).rejects.toThrow(/only on your Mac/);

    // Its push token is kept on the Always On for this phone (Beluga Push, when it exists, uses it).
    toMini.client.registerPush('fcm', 'tok', 'rk');
    await waitFor(() => mini.machines.pushOf(deviceId(phone.cert)), 5_000);
    expect(mini.machines.pushOf(deviceId(phone.cert))).toEqual({ platform: 'fcm', token: 'tok', relayKey: 'rk' });
  }, 240_000);
});
