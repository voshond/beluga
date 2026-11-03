import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CompanionClient, pairDevice } from '../src/companion/client.js';
import { deviceKeys, newSeed, parseDeviceTicket, verifyCert } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { Awake } from '../src/companion/awake.js';
import { CompanionHost } from '../src/companion/host.js';
import { HomeView } from '../src/companion/protocol.js';
import { type Nudge, idleWhenWatched } from '../src/companion/push.js';
import { attachCompanion } from '../src/companion/registry.js';
import { runAsClient } from '../src/core/client-context.js';
import { type Method, parseArgs } from '../src/ipc/api.js';
import { COMPANION_HANDLERS } from '../src/ipc/companion-handlers.js';
import { Store, initialState } from '../src/core/store.js';
import { generateIdentity } from '../src/net/crypto.js';
import { fromStream } from '../src/net/transport.js';
import { waitFor } from './helpers.js';

// Everything runs on a local testnet: these tests never touch the public DHT.
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

function mac(callLog: Array<{ client: string; method: string; args: readonly unknown[] }> = [], awake?: Awake, more: Partial<ConstructorParameters<typeof CompanionHost>[0]> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-companion-'));
  const identity = generateIdentity();
  const store = new Store(initialState('test room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  store.dispatch({ type: 'welcome', self: { peerId: identity.peerId, name: 'kayra', shares: [], agent: true, usage: { plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 }, updatedAt: 1 }, usages: [{ agent: { runtime: 'claude', label: 'Claude' }, plan: 'max', fiveHour: { pct: 12 }, week: { pct: 38 }, updatedAt: 1 }, { agent: { runtime: 'codex', model: 'gpt-5', label: 'Codex' }, windows: [{ label: 'Weekly', pct: 24 }], updatedAt: 1 }] } });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  const host = new CompanionHost({
    identity,
    store,
    devices,
    call: async (client, method, args) => {
      // The phone's own methods run as the daemon runs them: checked by the API, as that phone.
      if (method.startsWith('companion.')) {
        try {
          const handler = COMPANION_HANDLERS[method as keyof typeof COMPANION_HANDLERS] as (s: object, ...a: unknown[]) => unknown;
          const parsed = parseArgs(method as Method, args) as unknown[];
          return { ok: true, value: await runAsClient(client, () => handler(session, ...parsed)) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      callLog.push({ client, method, args });
      // What the daemon's handlers would answer, as far as the host relies on it.
      if (method === 'workspaces.newChat') return { ok: true, value: 'w9' };
      if (method === 'workspaces.startWorktree') return { ok: true, value: 'w10' };
      if (method === 'attachments.expand') return { ok: true, value: `expanded: ${String(args[0])}` };
      if (method === 'gateway.ask') return { ok: true, value: { id: 't_asked0000001', peerId: args[0] } };
      if (method === 'network.files.add') return { ok: true, value: (args[0] as string[]).map((p) => ({ sha: 'a'.repeat(64), name: path.basename(p), size: 3 })) };
      return { ok: true, value: `did ${method}` };
    },
    macName: () => 'Kayra’s Mac',
    version: '0.6.2',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' },
    coalesceMs: 50,
    ...(awake ? { awake } : {}),
    ...more,
  });
  const session = { setPrefs: (prefs: object) => store.dispatch({ type: 'prefs', prefs }), store, selfId: identity.peerId };
  attachCompanion(session, host);
  cleanup.push(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, store, devices, dir, identity };
}

function phone() {
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  const keys = deviceKeys(newSeed());
  return { node, keys, device: { keys, name: 'Pixel 9', platform: 'android' as const, app: '1.0.0' } };
}

describe('pairing a phone and its link', () => {
  it('pairs, links, shows home, calls what the phone may, refuses the rest, and drops a removed phone', async () => {
    const calls: Array<{ client: string; method: string; args: readonly unknown[] }> = [];
    const { host, store, devices, dir, identity } = mac(calls);
    await host.start();
    // Nobody paired, no pairing: no DHT node.
    expect(host.running).toBe(false);

    const info = await host.pairStart();
    expect(host.running).toBe(true);
    expect(info.link).toMatch(/^beluga:\/\/device#[\w-]{22}$/);
    expect(info.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(store.getState().companion.pairing?.link).toBe(info.link);

    const p = phone();
    let shown = '';
    const paired = pairDevice(p.node, info.link, p.device, { timeoutMs: 20_000, onWait: (fp) => (shown = fp) });
    const waiting = await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    expect(waiting.name).toBe('Pixel 9');
    // Both screens show the same four pictures.
    await waitFor(() => shown, 5_000);
    expect(waiting.fingerprint).toBe(shown);
    expect([...new Intl.Segmenter().segment(shown.replace(/ /g, ''))].length).toBe(4);

    const { id } = host.pairApprove();
    const result = await paired;
    expect(result.address).toBe(host.address());
    expect(result.macName).toBe('Kayra’s Mac');
    expect(result.cert.owner).toBe(identity.peerId);
    expect(verifyCert(result.cert)).toBe(true);
    // A certificate changed after signing doesn't verify.
    expect(verifyCert({ ...result.cert, name: 'Evil phone' })).toBe(false);
    expect(devices.size).toBe(1);
    if (process.platform !== 'win32') expect((statSync(path.join(dir, 'devices.json')).mode & 0o777).toString(8)).toBe('600');
    // Single use: the pairing is gone.
    await waitFor(() => !store.getState().companion.pairing, 5_000);

    const views: Array<{ topic: string; data: unknown }> = [];
    const closes: number[] = [];
    const client = new CompanionClient({ node: p.node, address: result.address, link: p.keys.link, app: '1.0.0', platform: 'android', topics: ['home'] });
    client.on('view', (topic, data) => views.push({ topic, data }));
    client.on('close', (code) => closes.push(code));
    cleanup.push(() => client.close());
    const welcome = await client.connect();
    expect(welcome.mac.name).toBe('Kayra’s Mac');
    expect(welcome.me.name).toBe('kayra');

    const home = await waitFor(() => views.find((v) => v.topic === 'home'), 10_000);
    const parsed = HomeView.parse(home.data);
    expect(parsed.usage[0]?.windows.map((w) => w.label)).toEqual(['5 hours', 'Week']);
    await waitFor(() => store.getState().companion.devices[0]?.linked, 5_000);
    expect(store.getState().companion.devices[0]).toMatchObject({ id, name: 'Pixel 9', platform: 'android', app: '1.0.0', linked: true, push: false });

    // A view that changes is sent again; one that didn't change isn't.
    const before = views.length;
    store.dispatch({ type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Run npm test?', detail: 'npm test', askedAt: 5 } });
    const next = await waitFor(() => views.slice(before).find((v) => v.topic === 'home'), 5_000);
    expect(HomeView.parse(next.data).needsYou[0]?.actions[0]).toEqual({ label: 'Approve', tone: 'main', method: 'host.answerApproval', args: ['yes', 'a1'] });

    // Allowed calls go to the API as the phone; Mac-only ones are refused before they're parsed.
    expect(await client.call('host.answerApproval', ['yes', 'a1'])).toBe('did host.answerApproval');
    expect(calls).toEqual([{ client: `phone:${id}`, method: 'host.answerApproval', args: ['yes', 'a1'] }]);
    await expect(client.call('session.setPrefs', [{ theme: 'calm' }])).rejects.toThrow(/only on your Mac/);
    await expect(client.call('workspaces.merge', ['x'])).rejects.toThrow(/only on your Mac/);
    await expect(client.call('no.suchMethod', [])).rejects.toThrow(/only on your Mac/);
    expect(calls).toHaveLength(1);

    // Back in front (BLG-105): the open link is checked with one ping, and the Mac answers it.
    expect(await client.probe(3_000)).toBe(true);

    // Removing the phone drops its link at once, and its key is refused from then on.
    expect(host.removeDevice(id)).toBe(true);
    await waitFor(() => closes.length > 0, 5_000);
    expect(closes[0]).toBe(4010);
    // A closed link fails the check at once, without waiting out the timeout.
    expect(await client.probe(60_000)).toBe(false);
    expect(store.getState().companion.devices).toEqual([]);
    // No phone and no pairing: the node stops.
    await waitFor(() => !host.running, 5_000);
    // Dialing again, it learns it was removed (the Mac's record names no phone), not "Mac offline" (BLG-126).
    const err = await client.connect().then(() => undefined, (e: unknown) => e as { report?: { removed?: boolean } });
    expect(err).toBeDefined();
    expect(err?.report?.removed).toBe(true);
  }, 60_000);

  it('tells a phone that stays connected in the background what finished, and keeps the Mac awake when it asks (BLG-127, BLG-128)', async () => {
    const started: string[][] = [];
    const awake = new Awake({
      platform: 'darwin',
      spawn: (_cmd, args) => {
        started.push([...args]);
        return { kill: () => true, once: () => undefined } as never;
      },
    });
    const { host, store } = mac([], awake);
    await host.start();
    const info = await host.pairStart();
    const p = phone();
    const paired = pairDevice(p.node, info.link, p.device, { timeoutMs: 20_000 });
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    host.pairApprove();
    const result = await paired;
    const client = new CompanionClient({ node: p.node, address: result.address, link: p.keys.link, app: '1.0.0', platform: 'android', topics: [] });
    const nudges: Array<{ kind: string; title: string }> = [];
    client.on('nudge', (n) => nudges.push(n));
    cleanup.push(() => client.close());
    await client.connect();
    await waitFor(() => store.getState().companion.devices[0]?.linked, 5_000);
    const me = store.getState().selfId!;
    const run = (event: 'started' | 'done', ts: number) => store.dispatch({ type: 'agent_event', owner: me, requestId: 'r1', requester: me, event, text: event === 'done' ? 'All tests pass' : '', ts, channel: 'ws:wt-1', itemId: 'i1' });

    // In front: a run finishing on the Mac isn't news for the phone.
    run('started', 1);
    await new Promise((r) => setTimeout(r, 300));
    run('done', 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(nudges).toEqual([]);

    // Away with the link kept open: it is.
    client.focus(false);
    await new Promise((r) => setTimeout(r, 200));
    store.dispatch({ type: 'agent_event', owner: me, requestId: 'r2', requester: me, event: 'started', text: '', ts: 3, channel: 'ws:wt-1', itemId: 'i2' });
    await new Promise((r) => setTimeout(r, 300));
    store.dispatch({ type: 'agent_event', owner: me, requestId: 'r2', requester: me, event: 'done', text: 'Merged', ts: 4, channel: 'ws:wt-1', itemId: 'i2' });
    const n = await waitFor(() => nudges[0], 5_000);
    expect(n.kind).toBe('done');
    expect(n.title).toMatch(/finished/);

    // Keep this Mac awake, from the phone: the Mac holds it while the phone is paired.
    expect(started).toEqual([]);
    await client.call('companion.keepAwake', ['power']);
    await waitFor(() => started.length > 0, 5_000);
    expect(started[0]![0]).toBe('-s');
    expect(store.getState().prefs.keepAwake).toBe('power');

    // Make Codex the default agent from the phone's usage cards: it reaches the Mac's settings (BLG-459).
    await client.call('companion.defaultAgent', ['codex']);
    expect(store.getState().prefs.defaultAgent).toEqual({ runtime: 'codex', model: 'gpt-5', label: 'Codex' });
    await client.call('companion.defaultAgent', ['claude']);
    expect(store.getState().prefs.defaultAgent).toBeUndefined();
    await expect(client.call('companion.defaultAgent', ['local'])).rejects.toThrow(/No local agent/);
  }, 60_000);

  it('with no window open, an approval, a question and a friend\'s request reach the phone as pushes and are answered there (BLG-645)', async () => {
    const calls: Array<{ client: string; method: string; args: readonly unknown[] }> = [];
    const pushed: Nudge[] = [];
    // A server, or a Mac mini with the app closed while someone types on it: no window, so the keyboard doesn't hold the news.
    const { host, store } = mac(calls, undefined, { idleMs: idleWhenWatched(() => 0, async () => 1_000), pusher: { push: async (_to, n) => void pushed.push(n) } });
    await host.start();
    const info = await host.pairStart();
    const p = phone();
    const paired = pairDevice(p.node, info.link, p.device, { timeoutMs: 20_000 });
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    host.pairApprove();
    const result = await paired;
    const open = async () => {
      const c = new CompanionClient({ node: p.node, address: result.address, link: p.keys.link, app: '1.0.0', platform: 'android', topics: [] });
      cleanup.push(() => c.close());
      await c.connect();
      await waitFor(() => store.getState().companion.devices[0]?.linked, 5_000);
      return c;
    };
    // The phone says how to push to it, then its app closes.
    const first = await open();
    first.registerPush('fcm', 'token-1', 'relay-key-1');
    await new Promise((r) => setTimeout(r, 200));
    first.close();
    await waitFor(() => !store.getState().companion.devices[0]?.linked, 5_000);

    store.dispatch({ type: 'approval_add', approval: { id: 'a-tool', kind: 'tool', title: 'Run npm install', detail: 'npm install', askedAt: 1 } });
    store.dispatch({ type: 'question_add', question: { qid: 'q1', requestId: 'r1', owner: store.getState().selfId!, channel: 'room', picked: {}, question: { kind: 'question', questions: [{ question: 'Which database?', header: '', options: [], multiSelect: false }] } } });
    store.dispatch({ type: 'approval_add', approval: { id: 'a-friend', kind: 'request', title: 'mia asks: take a screenshot', detail: '', peer: 'mia-peer-id', askedAt: 2 } });
    await waitFor(() => pushed.length >= 3, 5_000);
    expect(pushed.every((n) => n.kind === 'needsYou' && n.priority === 'high')).toBe(true);
    const titles = pushed.map((n) => n.title).join(' | ');
    for (const said of ['npm install', 'Which database?', 'screenshot']) expect(titles).toContain(said);

    // Opened from the push: each is answered from the phone.
    const back = await open();
    await back.call('host.answerApproval', ['yes', 'a-tool']);
    await back.call('questions.answer', ['q1', { kind: 'answers', answers: { 'Which database?': 'Postgres' } }]);
    await back.call('host.answerApproval', ['no', 'a-friend']);
    expect(calls.map((c) => c.method)).toEqual(['host.answerApproval', 'questions.answer', 'host.answerApproval']);
  }, 60_000);

  it('takes photos and files from the phone, asks in a new chat, asks a friend, and signs out only itself', async () => {
    const calls: Array<{ client: string; method: string; args: readonly unknown[] }> = [];
    const { host, store, devices } = mac(calls);
    await host.start();
    const info = await host.pairStart();
    const p = phone();
    const paired = pairDevice(p.node, info.link, p.device, { timeoutMs: 20_000 });
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    const { id } = host.pairApprove();
    const result = await paired;
    // Another phone, paired before: signing out must never touch it.
    const other = deviceKeys(newSeed());
    devices.add({ ...result.cert, device: Buffer.from(other.device.publicKey).toString('hex'), link: Buffer.from(other.link.publicKey).toString('hex'), box: Buffer.from(other.box.publicKey).toString('hex'), name: 'Old phone' });
    const otherId = Buffer.from(other.device.publicKey).toString('hex').slice(0, 16);

    const closes: Array<[number, string]> = [];
    const client = new CompanionClient({ node: p.node, address: result.address, link: p.keys.link, app: '1.0.0', platform: 'android' });
    client.on('close', (code, reason) => closes.push([code, reason]));
    cleanup.push(() => client.close());
    await client.connect();

    // A photo bigger than one piece, and a PDF.
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300_000, 7)]);
    const photo = await client.put('IMG_0001.png', 'image/png', png);
    const pdf = await client.put('notes.pdf', 'application/pdf', Buffer.from('%PDF'));
    expect(photo).toMatch(/^up:[\w-]{8,64}$/);
    await expect(client.call('companion.ask', [{ target: { project: 'p1' }, text: 'What is in this photo?', files: [photo, pdf] }])).resolves.toEqual({ topic: 'conv:ws:w9' });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(['workspaces.newChat', 'attachments.expand', 'session.submit']);
    expect(calls[0]!.args).toEqual(['p1', 'What is in this photo?']);
    const sent = calls[2]!.args as [string, { channel: string }];
    expect(sent[1]).toEqual({ channel: 'ws:w9' });
    expect(sent[0]).toMatch(/^expanded: What is in this photo\?\n\n\[image \d+\]\n\nFiles from my phone:\n- .*notes\.pdf$/);
    // A ref that isn't this phone's is refused.
    await expect(client.call('companion.ask', [{ target: { project: 'p1' }, text: 'x', files: ['up:not-a-real-one'] }])).rejects.toThrow(/gone/);

    // A new worktree with a photo (1.12): the photo is linked in its first message, plan mode goes along.
    calls.length = 0;
    await expect(client.call('companion.ask', [{ target: { project: 'p1', worktree: true, plan: true }, text: 'Fix this screen', files: [photo] }])).resolves.toEqual({ topic: 'conv:ws:w10' });
    expect(calls.map((c) => c.method)).toEqual(['attachments.expand', 'workspaces.startWorktree']);
    const started = calls[1]!.args as [string, string, unknown];
    expect(started[0]).toBe('p1');
    expect(started[1]).toMatch(/^expanded: Fix this screen\n\n\[image \d+\]$/);
    expect(started[2]).toEqual({ quiet: true, plan: true });

    // A chat message with a file.
    calls.length = 0;
    await client.call('companion.post', [{ conversation: `dm:${'b'.repeat(32)}`, text: 'look', files: [pdf] }]);
    expect(calls.map((c) => c.method)).toEqual(['network.files.add', 'network.post']);
    expect(calls[1]!.args[1]).toMatchObject({ text: 'look', files: [{ name: expect.stringMatching(/notes\.pdf$/) }] });

    // Asking a friend's Claude goes through the gateway, as from their card on the Mac.
    calls.length = 0;
    await expect(client.call('companion.askPerson', [{ peerId: 'b'.repeat(32), text: 'Take a screenshot of your desktop', needs: ['screen'] }])).resolves.toEqual({ topic: 'conv:task:t_asked0000001', task: 't_asked0000001' });
    expect(calls).toEqual([{ client: `phone:${id}`, method: 'gateway.ask', args: ['b'.repeat(32), 'Take a screenshot of your desktop', { needs: ['screen'] }] }]);

    // Only a phone can sign out, and only itself.
    expect(() => host.signOut('some-mac-window')).toThrow(/Only a phone/);
    await expect(client.call('companion.signOut', [])).resolves.toEqual({ signedOut: true });
    await waitFor(() => closes.length > 0, 5_000);
    expect(closes[0]).toEqual([4010, 'Signed out']);
    expect(devices.get(id)).toBeUndefined();
    expect(devices.get(otherId)?.cert.name).toBe('Old phone');
  }, 60_000);

  it('pairs with the typed code too, and refuses a wrong one', async () => {
    const { host, store } = mac();
    await host.start();
    const info = await host.pairStart();
    const p = phone();
    // A wrong code finds nobody.
    await expect(pairDevice(p.node, 'ZZZZ-ZZZZ-ZZZZ', p.device, { timeoutMs: 3_000 })).rejects.toThrow();
    const paired = pairDevice(p.node, info.code.toLowerCase().replace(/-/g, ' '), p.device, { timeoutMs: 20_000 });
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    host.pairApprove();
    const result = await paired;
    expect(result.cert.name).toBe('Pixel 9');

    // A phone speaking a newer major than this Mac answers is told to update it (4002), not served.
    const stream = p.node.connect(Buffer.from(result.address, 'hex'), { keyPair: { publicKey: Buffer.from(p.keys.link.publicKey), secretKey: Buffer.from(p.keys.link.secretKey) } });
    const raw = fromStream(stream, { maxBytes: 1 << 20 });
    raw.on('error', () => undefined);
    const said: string[] = [];
    raw.on('message', (m) => said.push(m));
    raw.once('open', () => raw.send(JSON.stringify({ t: 'hello', v: { major: 99, minor: 0 }, app: '9.0.0', platform: 'android', topics: ['home'] })));
    const code = await new Promise<number>((resolve) => raw.once('close', resolve));
    expect(code).toBe(4002);
    expect(said.map((m) => JSON.parse(m) as { t: string; reason?: string })).toEqual([{ t: 'bye', reason: 'Update Beluga on your Mac' }]);
  }, 60_000);

  it('tells a waiting phone no when the pairing is cancelled', async () => {
    const { host, store } = mac();
    await host.start();
    const info = await host.pairStart();
    const p = phone();
    const paired = pairDevice(p.node, info.link, p.device, { timeoutMs: 20_000 }).catch((err: Error) => err);
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    await host.pairCancel();
    expect(String(await paired)).toMatch(/closed/);
  }, 60_000);

  it('reads tickets loosely', () => {
    expect(parseDeviceTicket('beluga://device#abcdefghijklmnopqrstuv')).toEqual({ via: 'link', secret: 'abcdefghijklmnopqrstuv' });
    expect(parseDeviceTicket('k7qm 4xpa r2td')).toEqual({ via: 'code', code: 'K7QM4XPAR2TD' });
    expect(parseDeviceTicket('beluga://device?code=K7QM-4XPA-R2TD')).toEqual({ via: 'code', code: 'K7QM4XPAR2TD' });
    expect(parseDeviceTicket('hello')).toBeUndefined();
  });
});
