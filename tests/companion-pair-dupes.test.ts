import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pairDevice } from '../src/companion/client.js';
import { deviceKeys, deviceSecrets, newSeed, parseDeviceTicket, signKeyPair } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { Store, initialState } from '../src/core/store.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * One phone, more than one stream to the same pairing (BLG-674): another way that lost, or the app
 * trying again with the same keys. The phone that waits stays waiting.
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

async function mac() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-pair-dupes-'));
  const identity = generateIdentity();
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  const host = new CompanionHost({
    identity,
    store,
    devices: new DeviceBook(path.join(dir, 'devices.json')),
    call: async () => ({ ok: true, value: undefined }),
    macName: () => 'homelab',
    version: '0.6.2',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' },
    coalesceMs: 50,
  });
  cleanup.push(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  return { host, store };
}

function node(): DHT {
  const n = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => n.destroy({ force: true }));
  return n;
}

const device = (name: string, seed = newSeed()) => ({ keys: deviceKeys(seed), name, platform: 'android' as const, app: '1.1.0' });

describe('a phone with two streams to one pairing', () => {
  it('closing the other stream never clears the phone that waits', async () => {
    const { host, store } = await mac();
    const info = await host.pairStart();
    const phone = node();
    const me = device('Pixel 9');
    // The way that lost: open (Noise done, so the Mac served it), no hello, then dropped.
    const target = signKeyPair((await deviceSecrets(parseDeviceTicket(info.link)!)).seed).publicKey;
    const loser = phone.connect(Buffer.from(target), { keyPair: { publicKey: Buffer.from(me.keys.link.publicKey), secretKey: Buffer.from(me.keys.link.secretKey) } } as never);
    loser.on('error', () => undefined);
    await new Promise<void>((r) => loser.once('open', () => r()));
    const paired = pairDevice(phone, info.link, me, { timeoutMs: 20_000 });
    const waiting = await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    loser.destroy();
    await new Promise((r) => setTimeout(r, 500));
    expect(store.getState().companion.pairing?.waiting).toEqual(waiting);
    host.pairApprove();
    expect((await paired).cert.name).toBe('Pixel 9');
  }, 60_000);

  it('the same phone saying hello again takes over the wait; another phone is told it’s busy', async () => {
    const { host, store } = await mac();
    const info = await host.pairStart();
    const seed = newSeed();
    const first = pairDevice(node(), info.link, device('Pixel 9', seed), { timeoutMs: 20_000 }).catch((err: Error) => err);
    const one = await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    // The app tried again with the same keys (a second scan): that stream is the one that waits now.
    const again = pairDevice(node(), info.link, device('Pixel 9', seed), { timeoutMs: 20_000 });
    const two = await waitFor(() => {
      const w = store.getState().companion.pairing?.waiting;
      return w && w.fingerprint !== one.fingerprint ? w : undefined;
    }, 15_000);
    expect(two.name).toBe('Pixel 9');
    expect(await first).toBeInstanceOf(Error);
    expect(store.getState().companion.pairing?.waiting).toEqual(two);
    // Someone else's phone meanwhile: busy, and the wait is untouched.
    await expect(pairDevice(node(), info.link, device('Other'), { timeoutMs: 20_000 })).rejects.toThrow(/Another phone is pairing/);
    expect(store.getState().companion.pairing?.waiting).toEqual(two);
    host.pairApprove();
    expect((await again).fingerprint).toBe(two.fingerprint);
  }, 60_000);
});
