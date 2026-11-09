import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pairDevice } from '../src/companion/client.js';
import { deviceKeys, hex, newSeed } from '../src/companion/device-crypto.js';
import { DeviceBook, deviceId } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { Store, initialState } from '../src/core/store.js';
import { Machines } from '../src/machines/machines.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * Joining a computer for real (BLG-774): an app and computers as the daemon runs them (a companion
 * host each, its device set beside it) on a local DHT. The computer opens a pairing, the app joins
 * it with the link or the code after both show the same pictures, and a device forgotten on any of
 * them is cut off on all of them.
 */

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

async function install(name: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-machines-'));
  const identity = generateIdentity();
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
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
    // What it has free, as a computer says it (BLG-778; the real collector is tested in machine-info.test.ts).
    info: async () => ({ at: Date.now(), cpus: 4, loadPerCore: 0.5, memory: { freeGB: 6, totalGB: 16 }, agentsRunning: 1, runtimes: [{ id: 'claude', state: 'ready' as const }], gh: 'signed_in' as const, mcp: [], projects: [{ name: 'beluga', origin: 'git@github.com:kayraucklnc/beluga.git' }] }),
    pollMs: 60_000,
  });
  host = new CompanionHost({
    identity,
    store,
    devices,
    call: async () => ({ ok: true, value: undefined }),
    macName: () => name,
    version: '0.9.0',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' },
    coalesceMs: 50,
    machines,
  });
  cleanup.push(async () => {
    await machines.stop();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  machines.start();
  return { dir, identity, host, machines, devices, store };
}

type Install = Awaited<ReturnType<typeof install>>;

/** The computer opens a pairing; the app joins it with `use` (the link or the code), both checking the pictures. */
async function join(app: Install, computer: Install, use: 'link' | 'code' = 'link') {
  const info = await computer.machines.pairStart();
  // A code works once it listens too (its Argon2id is slow on a busy or small computer).
  if (use === 'code') await waitFor(() => computer.machines.pairStatus().open?.codeReady, 30_000);
  const offer = await app.machines.joinStart(use === 'link' ? info.link : info.code);
  const shown = computer.machines.pairStatus().open?.waiting;
  expect(shown?.fingerprint).toBe(offer.fingerprint);
  const added = await app.machines.joinApprove();
  await waitFor(() => computer.machines.pairStatus().last?.kind === 'joined', 10_000);
  return { info, offer, added };
}

describe('joining a computer', () => {
  it('the app joins it with the link, after both show the same pictures', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    const { info, offer, added } = await join(app, mini);
    expect(info.link).toMatch(/^beluga:\/\/computer#[\w-]{22}/);
    expect(info.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(info.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(offer).toMatchObject({ name: 'mini', platform: 'linux', version: '0.9.0' });
    expect(offer.fingerprint.split(' ')).toHaveLength(4);
    expect(added.name).toBe('mini');

    // The app keeps it in machines.json (0600); the computer is now in your set, and lets your app in.
    expect(app.machines.list().map((m) => m.name)).toEqual(['mini']);
    if (process.platform !== 'win32') expect(statSync(path.join(app.dir, 'machines.json')).mode & 0o777).toBe(0o600);
    expect(mini.machines.set.owner().peerId).toBe(app.identity.peerId);
    const appCert = app.machines.set.self()!;
    expect(mini.machines.admit(appCert.link)?.role).toBe('app');
    expect(mini.machines.devicesInSet().find((d) => d.self)).toMatchObject({ name: 'mini', role: 'computer' });
    // It's never listed as a phone.
    expect(app.store.getState().companion.devices).toEqual([]);
    expect(mini.store.getState().companion.devices).toEqual([]);
  }, 90_000);

  it('the code works too, and each pairing works once', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    const { info } = await join(app, mini, 'code');
    expect(app.machines.list().map((m) => m.name)).toEqual(['mini']);
    // Used: the pairing is gone, its link finds nothing.
    expect(mini.machines.pairStatus().open).toBeUndefined();
    await expect(app.machines.joinStart(info.link)).rejects.toThrow(/isn’t answering/);
  }, 120_000);

  it('saying no leaves the computer as it was', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    const info = await mini.machines.pairStart();
    await app.machines.joinStart(info.link);
    await app.machines.joinCancel();
    await waitFor(() => mini.machines.pairStatus().last?.kind === 'declined', 10_000);
    expect(mini.machines.set.holdsIdentity).toBe(true);
    expect(app.machines.list()).toEqual([]);
    expect(app.machines.set.devices().map((d) => d.role)).toEqual(['app']);
  }, 90_000);

  it('a computer already someone else’s refuses another app', async () => {
    const mine = await install('MacBook');
    const theirs = await install('Their Mac');
    const mini = await install('mini');
    await join(mine, mini);
    const info = await mini.machines.pairStart();
    await expect(theirs.machines.joinStart(info.link)).rejects.toThrow(/someone else’s/);
  }, 90_000);
});

describe('forgetting a device anywhere', () => {
  it('a phone forgotten on one computer is cut off on the app and the other computer', async () => {
    const app = await install('MacBook');
    // A phone paired with the app, the way phones always have been.
    const pairing = await app.host.pairStart();
    const phoneNode = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
    cleanup.push(() => phoneNode.destroy({ force: true }));
    const paired = pairDevice(phoneNode, pairing.link, { keys: deviceKeys(newSeed()), name: 'Pixel 9', platform: 'android', app: '1.4.0' }, { timeoutMs: 30_000 });
    await waitFor(() => app.store.getState().companion.pairing?.waiting, 20_000);
    app.host.pairApprove();
    const phone = (await paired).cert;
    expect(phone.role).toBeUndefined();

    const mini = await install('mini');
    const aws = await install('aws');
    await join(app, mini);
    await join(app, aws);
    // Both hear the whole set (the second join reaches the first computer through the sync).
    await waitFor(() => mini.machines.set.devices().length === 4 && aws.machines.set.devices().length === 4, 20_000);

    const onMini = mini.machines.devicesInSet().find((d) => d.name === 'Pixel 9')!;
    expect(onMini.role).toBe('phone');
    mini.machines.forget(onMini.id);
    // Cut off where it was forgotten at once, then on the app (its phone book too), then on the other computer.
    expect(mini.machines.set.holds(phone)).toBe(false);
    await waitFor(() => !app.devices.get(deviceId(phone)), 20_000);
    await waitFor(() => !aws.machines.set.holds(phone), 20_000);
    expect(app.machines.set.roster()!.devices.map((d) => d.name).sort()).toEqual(['MacBook', 'aws', 'mini']);
  }, 180_000);

  it('a computer forgotten on the app can no longer reach it', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    const aws = await install('aws');
    await join(app, mini);
    await join(app, aws);
    const awsId = app.machines.list().find((m) => m.name === 'aws')!.id;
    app.machines.forget(awsId);
    expect(app.machines.list().map((m) => m.name)).toEqual(['mini']);
    const awsLink = hex(aws.machines.keys.link.publicKey);
    expect(app.machines.admit(awsLink)).toBeUndefined();
    await waitFor(() => mini.machines.devicesInSet().every((d) => d.name !== 'aws'), 20_000);
    // Its own sync to the app is turned away at the door.
    await expect(aws.machines.syncWith(aws.machines.book.all()[0]!)).rejects.toThrow();
  }, 180_000);
});

describe('what each computer has free (BLG-778)', () => {
  it('machines.list says each computer is online, its round trip, and what it has free; a stopped one is offline', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    await join(app, mini);
    expect(app.machines.list()[0]!.status).toBe('unknown');
    await app.machines.poll();
    const [view] = app.machines.list();
    expect(view).toMatchObject({ name: 'mini', status: 'online', info: { cpus: 4, loadPerCore: 0.5, memory: { freeGB: 6 }, agentsRunning: 1, gh: 'signed_in', runtimes: [{ id: 'claude', state: 'ready' }], projects: [{ name: 'beluga', origin: 'git@github.com:kayraucklnc/beluga.git' }] } });
    expect(view!.rttMs).toBeGreaterThanOrEqual(0);
    // Only an app hears what a computer has free: a computer asking the app gets the set alone.
    expect(await mini.machines.syncWith(mini.machines.book.all()[0]!, true)).toBe(true);

    await mini.machines.stop();
    await mini.host.stop();
    await app.machines.poll();
    const [after] = app.machines.list();
    expect(after).toMatchObject({ status: 'offline', info: { cpus: 4 } });
    expect(after!.rttMs).toBeUndefined();
  }, 120_000);
});

