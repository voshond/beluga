import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { Io } from '../src/cli/io.js';
import { type PairLink, pair } from '../src/cli/pair.js';
import { pairDevice } from '../src/companion/client.js';
import { deviceKeys, newSeed } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { wsPipe } from '../src/companion/relay.js';
import { Store, initialState } from '../src/core/store.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * `beluga pair` against a host with both ways open, the direct one and the relay, and a phone
 * that dials both at once (BLG-674): the terminal keeps asking until it's answered, every time.
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

/** Cloudflare's tunnel, played by a plain WebSocket proxy to the host's relay server. */
const tunnel = async (port: number) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (down, req) => {
    const up = new WebSocket(`ws://127.0.0.1:${port}${req.url ?? '/'}`);
    const queue: Buffer[] = [];
    const code = (c: number): number => (c >= 4000 || c === 1000 ? c : 1000);
    down.on('message', (data: Buffer) => (up.readyState === up.OPEN ? up.send(data) : queue.push(data)));
    up.on('open', () => queue.splice(0).forEach((d) => up.send(d)));
    up.on('message', (data: Buffer) => down.readyState === down.OPEN && down.send(data));
    up.on('close', (c) => down.readyState === down.OPEN && down.close(code(c)));
    down.on('close', (c) => (up.readyState === up.OPEN ? up.close(code(c)) : up.terminate()));
    up.on('error', () => down.terminate());
    down.on('error', () => up.terminate());
  });
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/companion`, close: () => wss.close() };
};

async function daemonSide() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-cli-pair-relay-'));
  const identity = generateIdentity();
  const store = new Store(initialState('test room'));
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
    relay: tunnel,
    coalesceMs: 50,
  });
  cleanup.push(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  const link: PairLink = {
    start: () => host.pairStart(),
    approve: async () => host.pairApprove(),
    cancel: () => host.pairCancel(),
    companion: () => store.getState().companion,
    onChange: (l) => store.subscribe(l),
  };
  return { host, store, link };
}

function phone(name: string) {
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  const sockets: WebSocket[] = [];
  const openRelay = (url: string) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    return wsPipe(ws, false);
  };
  cleanup.push(() => sockets.forEach((s) => s.terminate()));
  return { node, openRelay, device: { keys: deviceKeys(newSeed()), name, platform: 'android' as const, app: '1.1.0' } };
}

const quietIo = (): Io & { text: () => string } => {
  let all = '';
  return { out: (t) => void (all += t), err: (t) => void (all += t), text: () => all };
};

/** One `beluga pair`: the phone scans the printed link and dials both ways at once; y after a while. */
async function onePairing(link: PairLink, store: Store, name: string, answerAfterMs: number) {
  const io = quietIo();
  let started!: { link: string };
  const p = phone(name);
  const pairing = pair({ ...link, start: async () => (started = await link.start()) }, io, {
    tty: false,
    ask: () => new Promise((r) => setTimeout(() => r('y'), answerAfterMs)),
  });
  await waitFor(() => started, 10_000);
  // The relay's URL is in the link once its tunnel answers.
  const withRelay = await waitFor(() => store.getState().companion.pairing?.link.includes('?r=') && store.getState().companion.pairing?.link, 10_000);
  const paired = pairDevice(p.node, withRelay, p.device, { timeoutMs: 30_000, openRelay: p.openRelay, staggerMs: 0 }).catch((err: Error) => err);
  const code = await pairing;
  return { code, io, paired: await paired };
}

describe('beluga pair with the direct way and the relay both open', () => {
  it('keeps asking until answered, and y pairs, ten times on one daemon', async () => {
    const { host, store, link } = await daemonSide();
    for (let i = 0; i < 10; i++) {
      const { code, io, paired } = await onePairing(link, store, `Phone ${i}`, 1500);
      expect({ i, code, said: code === 0 ? 'ok' : io.text().split('\n').filter((l) => !/[█▀▄]/.test(l)).join('\n') + ' | phone: ' + String(paired) }).toEqual({ i, code: 0, said: 'ok' });
      expect(paired).not.toBeInstanceOf(Error);
      // A phone can have only four computers' worth of company: each goes before the next.
      for (const d of store.getState().companion.devices) host.removeDevice(d.id);
    }
  }, 240_000);

  it('after a pairing that was cancelled or given up, the next one on the same daemon pairs', async () => {
    const { host, store, link } = await daemonSide();
    const relayLink = () => waitFor(() => store.getState().companion.pairing?.link.includes('?r=') && store.getState().companion.pairing?.link, 10_000);
    const waiting = () => waitFor(() => store.getState().companion.pairing?.waiting, 15_000);

    // Ctrl+C while the phone waits.
    const ctrlC = new AbortController();
    const first = pair(link, quietIo(), { tty: false, signal: ctrlC.signal, ask: () => new Promise(() => undefined) });
    const p1 = phone('One');
    const dialed1 = pairDevice(p1.node, await relayLink(), p1.device, { timeoutMs: 30_000, openRelay: p1.openRelay, staggerMs: 0 }).catch((err: Error) => err);
    await waiting();
    ctrlC.abort();
    expect(await first).toBe(130);
    expect(await dialed1).toBeInstanceOf(Error);

    // Ctrl+C before any phone came.
    const early = new AbortController();
    const second = pair(link, quietIo(), { tty: false, signal: early.signal, ask: () => new Promise(() => undefined) });
    await relayLink();
    early.abort();
    expect(await second).toBe(130);

    // A pairing left open with a phone waiting (the terminal went away), then a new `beluga pair`.
    await host.pairStart();
    const p3 = phone('Three');
    const dialed3 = pairDevice(p3.node, await relayLink(), p3.device, { timeoutMs: 30_000, openRelay: p3.openRelay, staggerMs: 0 }).catch((err: Error) => err);
    await waiting();

    const { code, io, paired } = await onePairing(link, store, 'Four', 500);
    expect({ code, said: code === 0 ? 'ok' : io.text() }).toEqual({ code: 0, said: 'ok' });
    expect(paired).not.toBeInstanceOf(Error);
    expect(await dialed3).toBeInstanceOf(Error);
    expect(store.getState().companion.devices.map((d) => d.name)).toEqual(['Four']);
  }, 120_000);

  it('a new `beluga pair` right after one closed listens on a node that stays (record puts as slow as the real DHT’s)', async () => {
    const { host, store, link } = await daemonSide();
    // A pairing that was left (no phone ever came): its node is up.
    await host.pairStart();
    const node = await waitFor(() => (host as unknown as { node?: { mutablePut: (...a: unknown[]) => Promise<unknown> } }).node, 10_000);
    const put = node.mutablePut.bind(node);
    // On the internet a put takes seconds: the closing pairing's last put is still going when the next opens.
    node.mutablePut = async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 1500));
      return put(...a);
    };
    const { code, io, paired } = await onePairing(link, store, 'Late', 2500);
    expect({ code, said: code === 0 ? 'ok' : io.text() }).toEqual({ code: 0, said: 'ok' });
    expect(paired).not.toBeInstanceOf(Error);
  }, 120_000);
});
