import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type PairLink, pair } from '../src/cli/pair.js';
import { findPhone, listPhones, removePhone } from '../src/cli/phones.js';
import { qrLines, qrWidth } from '../src/cli/qr.js';
import type { Io } from '../src/cli/io.js';
import { pairDevice } from '../src/companion/client.js';
import { deviceKeys, deviceLink, newSeed } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import type { DeviceView } from '../src/companion/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

// A test daemon's phone side and a fake phone, on a local testnet: never the public DHT.
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

function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

/** What `beluga pair` drives on the daemon, straight on its companion host. */
function daemonSide() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-cli-pair-'));
  const store = new Store(initialState('test room'));
  const identity = generateIdentity();
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
  const link: PairLink = {
    start: () => host.pairStart(),
    approve: async () => host.pairApprove(),
    cancel: () => host.pairCancel(),
    companion: () => store.getState().companion,
    onChange: (l) => store.subscribe(l),
  };
  return { host, store, link };
}

function phone(name = 'Pixel 9') {
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  const keys = deviceKeys(newSeed());
  return { node, device: { keys, name, platform: 'android' as const, app: '1.0.0' } };
}

describe('beluga pair', () => {
  it('shows the QR code and the code, the phone’s name and four pictures, and pairs on y', async () => {
    const { host, store, link } = daemonSide();
    await host.start();
    const io = capture();
    let asked = '';
    let started!: { link: string; code: string };
    const spy: PairLink = { ...link, start: async () => (started = await link.start()) };
    const p = phone();
    let phoneSaw = '';
    const pairing = pair(spy, io, {
      tty: false,
      columns: 80,
      ask: async (q) => {
        asked = q;
        return 'y';
      },
    });
    await waitFor(() => started, 10_000);
    const paired = pairDevice(p.node, started.link, p.device, { timeoutMs: 20_000, onWait: (f) => (phoneSaw = f) });
    expect(await pairing).toBe(0);
    await paired;
    const out = io.text();
    expect(out).toMatch(/[█▀▄]/);
    expect(out).toContain(`type this code on the phone: ${started.code}`);
    expect(out).toContain('“Pixel 9” wants to pair');
    expect(phoneSaw.split(' ')).toHaveLength(4);
    expect(out).toContain(phoneSaw);
    expect(asked).toBe('Pair? [y/N] ');
    expect(out).toContain('Paired with Pixel 9');
    expect(io.errors()).toMatch(/code works for (10:00|9:\d\d) more/);
    expect(store.getState().companion.devices.map((d) => d.name)).toEqual(['Pixel 9']);

    // Listed, and removed by name: it's refused from then on.
    const list = capture();
    listPhones(store.getState().companion.devices, list);
    expect(list.text()).toMatch(/Pixel 9 +Android, (linked now|not seen yet|last seen .+ ago), paired/);
    const book = { devices: () => store.getState().companion.devices, remove: async (id: string) => host.removeDevice(id) };
    const removed = capture();
    expect(await removePhone(book, 'pixel 9', removed)).toBe(0);
    expect(removed.text()).toContain('Removed Pixel 9');
    expect(store.getState().companion.devices).toEqual([]);
  }, 60_000);

  it('tells the phone no on anything but y', async () => {
    const { host, store, link } = daemonSide();
    await host.start();
    let started!: { link: string };
    const io = capture();
    const pairing = pair({ ...link, start: async () => (started = await link.start()) }, io, { tty: false, ask: async () => '' });
    await waitFor(() => started, 10_000);
    const p = phone();
    const paired = pairDevice(p.node, started.link, p.device, { timeoutMs: 20_000 }).catch((err: Error) => err);
    expect(await pairing).toBe(1);
    expect(await paired).toBeInstanceOf(Error);
    expect(io.errors()).toContain('Not paired');
    expect(store.getState().companion.devices).toEqual([]);
    expect(store.getState().companion.pairing).toBeUndefined();
  }, 60_000);

  it('Ctrl+C while waiting for a phone cancels the pairing', async () => {
    const { host, store, link } = daemonSide();
    await host.start();
    const ctrlC = new AbortController();
    const io = capture();
    const waiting = pair(link, io, { tty: true, signal: ctrlC.signal, ask: () => new Promise(() => undefined) });
    await waitFor(() => store.getState().companion.pairing, 10_000);
    ctrlC.abort();
    expect(await waiting).toBe(130);
    expect(io.errors()).toContain('Pairing cancelled');
    await waitFor(() => !store.getState().companion.pairing, 5_000);
  }, 30_000);

  it('Ctrl+C at Pair? tells the phone no', async () => {
    const { host, store, link } = daemonSide();
    await host.start();
    let started!: { link: string };
    const ctrlC = new AbortController();
    const io = capture();
    const atPrompt = pair({ ...link, start: async () => (started = await link.start()) }, io, { tty: false, signal: ctrlC.signal, ask: () => new Promise(() => undefined) });
    await waitFor(() => started, 10_000);
    const p = phone();
    const paired = pairDevice(p.node, started.link, p.device, { timeoutMs: 20_000 }).catch((err: Error) => err);
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    ctrlC.abort();
    expect(await atPrompt).toBe(130);
    expect(await paired).toBeInstanceOf(Error);
    expect(store.getState().companion.devices).toEqual([]);
  }, 60_000);

  it('says so when the code runs out before a phone uses it', async () => {
    const { host, link } = daemonSide();
    await host.start();
    const io = capture();
    const pairing = pair({ ...link, start: async () => {
      const info = await link.start();
      setTimeout(() => void host.pairCancel(), 50);
      return info;
    } }, io, { tty: false, ask: async () => 'y' });
    expect(await pairing).toBe(1);
    expect(io.errors()).toContain('expired');
  }, 30_000);
});

describe('a phone whose link drops while Pair? is asked (BLG-674)', () => {
  /** A daemon whose waiting phone the test moves around. */
  function scriptedLink() {
    const store = new Store(initialState('room'));
    const info = { link: 'beluga://device#abcdefghijklmnopqrstuvwxyz012345', code: 'K7QM-4XPA-R2TD', expiresAt: Date.now() + 600_000 };
    const set = (pairing?: object, devices: DeviceView[] = []): void => store.dispatch({ type: 'companion', companion: { devices, ...(pairing ? { pairing } : {}) } as never });
    const calls: string[] = [];
    const link: PairLink = {
      start: async () => (set(info), info),
      approve: async () => {
        calls.push('approve');
        set(undefined, [{ id: 'aaaaaaaaaaaaaaaa', name: 'Pixel 9', platform: 'android', pairedAt: Date.now(), linked: false, push: false } as DeviceView]);
      },
      cancel: async () => void (calls.push('cancel'), set(undefined)),
      companion: () => store.getState().companion,
      onChange: (l) => store.subscribe(l),
    };
    const waits = (fingerprint: string): void => set({ ...info, waiting: { name: 'Pixel 9', fingerprint } });
    const away = (): void => set(info);
    return { link, waits, away, calls };
  }

  it('keeps asking while it comes back, says its new pictures, and y pairs', async () => {
    const { link, waits, away, calls } = scriptedLink();
    const io = capture();
    let answer!: (a: string) => void;
    const pairing = pair(link, io, { tty: false, awayGraceMs: 1000, ask: () => new Promise((r) => (answer = r)) });
    await new Promise((r) => setTimeout(r, 20));
    waits('🐙 🌵 🎈 🦊');
    await waitFor(() => answer, 2000);
    // The losing way closes and the phone tries again: a moment with nobody waiting, then new pictures.
    away();
    await new Promise((r) => setTimeout(r, 300));
    waits('🐳 🍋 🚲 🌙');
    await waitFor(() => io.text().includes('new pictures'), 2000);
    expect(io.text()).toContain('“Pixel 9” shows 🐳 🍋 🚲 🌙');
    answer('y');
    expect(await pairing).toBe(0);
    expect(calls).toEqual(['approve']);
    expect(io.text()).toContain('Paired with Pixel 9');
  });

  it('a yes while the phone is between two tries pairs it once it’s back', async () => {
    const { link, waits, away, calls } = scriptedLink();
    let answer!: (a: string) => void;
    const pairing = pair(link, capture(), { tty: false, awayGraceMs: 1000, ask: () => new Promise((r) => (answer = r)) });
    await new Promise((r) => setTimeout(r, 20));
    waits('🐙 🌵 🎈 🦊');
    await waitFor(() => answer, 2000);
    away();
    answer('y');
    await new Promise((r) => setTimeout(r, 200));
    waits('🐙 🌵 🎈 🦊');
    expect(await pairing).toBe(0);
    expect(calls).toEqual(['approve']);
  });

  it('gives up only once nobody has waited for the whole grace, and closes the pairing', async () => {
    const { link, waits, away, calls } = scriptedLink();
    const io = capture();
    const pairing = pair(link, io, { tty: false, awayGraceMs: 300, ask: () => new Promise(() => undefined) });
    await new Promise((r) => setTimeout(r, 20));
    waits('🐙 🌵 🎈 🦊');
    await new Promise((r) => setTimeout(r, 50));
    away();
    expect(await pairing).toBe(1);
    expect(io.errors()).toContain('The phone stopped waiting');
    expect(calls).toEqual(['cancel']);
  });
});

describe('the QR code in a terminal', () => {
  const link = deviceLink('A'.repeat(43), 'https://some-long-words-here-and-there.trycloudflare.com');

  it('fits an 80-column terminal, painted black on white', () => {
    const lines = qrLines(link);
    expect(qrWidth(lines)).toBeLessThanOrEqual(80);
    expect(lines[0]).toMatch(/^\x1b\[30;107m/);
    // Half blocks: about half as tall as wide.
    expect(lines.length).toBeLessThanOrEqual(Math.ceil(qrWidth(lines) / 2) + 1);
    expect(qrLines(link, { color: false }).join('')).not.toContain('\x1b');
  });

  it('gives way to the typed code in a narrow window', async () => {
    const io = capture();
    const store = new Store(initialState('room'));
    const link2: PairLink = {
      start: async () => {
        store.dispatch({ type: 'companion', companion: { devices: [], pairing: { link, code: 'K7QM-4XPA-R2TD', expiresAt: Date.now() + 60_000 } } });
        setTimeout(() => store.dispatch({ type: 'companion', companion: { devices: [] } }), 20);
        return { link, code: 'K7QM-4XPA-R2TD', expiresAt: Date.now() + 60_000 };
      },
      approve: async () => undefined,
      cancel: async () => undefined,
      companion: () => store.getState().companion,
      onChange: (l) => store.subscribe(l),
    };
    await pair(link2, io, { tty: false, columns: 30, ask: async () => 'n' });
    expect(io.text()).toContain('too narrow');
    expect(io.text()).not.toMatch(/[█▀▄]/);
    expect(io.text()).toContain('K7QM-4XPA-R2TD');
  });
});

describe('beluga phones', () => {
  const now = 1_000_000_000;
  const d = (id: string, name: string, more: Partial<DeviceView> = {}): DeviceView => ({ id, name, platform: 'android', pairedAt: now - 86_400_000, linked: false, push: false, ...more }) as DeviceView;

  it('lists them, or says how to pair one', () => {
    const none = capture();
    listPhones([], none, now);
    expect(none.text()).toContain('beluga pair');
    const some = capture();
    listPhones([d('aaaaaaaaaaaaaaaa', 'Pixel', { linked: true }), d('bbbbbbbbbbbbbbbb', 'iPad', { platform: 'ios', lastSeen: now - 3_600_000 })], some, now);
    expect(some.text()).toContain('Pixel  Android, linked now, paired 1 day ago  (aaaaaaaaaaaaaaaa)');
    expect(some.text()).toContain('iPad   iPhone, last seen 1 hour ago');
  });

  it('finds the one meant, by name in any case or by id, and says when it can’t', async () => {
    const list = [d('aaaaaaaaaaaaaaaa', 'Pixel'), d('bbbbbbbbbbbbbbbb', 'Work'), d('cccccccccccccccc', 'Work')];
    expect(findPhone(list, 'PIXEL')).toMatchObject({ id: 'aaaaaaaaaaaaaaaa' });
    expect(findPhone(list, 'cccccccccccccccc')).toMatchObject({ name: 'Work' });
    expect(findPhone(list, 'work')).toMatch(/2 phones are called/);
    expect(findPhone(list, 'nope')).toMatch(/No paired phone is called “nope”. Paired: Pixel, Work, Work/);
    const io = capture();
    expect(await removePhone({ devices: () => list, remove: async () => undefined }, undefined, io)).toBe(2);
    expect(await removePhone({ devices: () => list, remove: async () => undefined }, 'nope', io)).toBe(1);
  });
});
