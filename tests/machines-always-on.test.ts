import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceKeys, hex, newSeed } from '../src/companion/device-crypto.js';
import { deviceId } from '../src/companion/devices.js';
import type { DeviceCert } from '../src/companion/protocol.js';
import { type SwappableIdentity, swappableIdentity } from '../src/core/identity.js';
import { AlwaysOn } from '../src/machines/always-on.js';
import { parseAo } from '../src/machines/always-on-bundle.js';
import { networkElsewhere, readAlwaysOn } from '../src/machines/always-on-state.js';
import { identitiesAtStart } from '../src/machines/identity-load.js';
import type { MachineRecord } from '../src/machines/book.js';
import { DeviceSet } from '../src/machines/controllers.js';
import type { Machines } from '../src/machines/machines.js';
import { type Identity, generateIdentity, identityFromPem, loadIdentity, saveIdentity } from '../src/net/crypto.js';
import type { MessageSocket } from '../src/net/transport.js';
import type { Settings } from '../src/shared/settings-schema.js';

/** Make Always On (BLG-796): your identity and friends network move to a computer of yours, and back, over the link. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-always-on-'));
  dirs.push(d);
  return d;
};

let clock = 1_700_000_000_000;
const now = (): number => ++clock;

/** Two ends of a link, in memory: what one sends the other hears (a turn later, as over a network). */
class End extends EventEmitter implements MessageSocket {
  peer!: End;
  isOpen = true;
  send(data: string): void {
    if (!this.isOpen) return;
    setImmediate(() => this.peer.isOpen && this.peer.emit('message', data));
  }
  close(code = 1000): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    setImmediate(() => {
      this.emit('close', code);
      if (this.peer.isOpen) {
        this.peer.isOpen = false;
        this.peer.emit('close', code);
      }
    });
  }
  terminate(): void {
    this.close(1006);
  }
  ping(): void {}
}
const pair = (): [End, End] => {
  const a = new End();
  const b = new End();
  a.peer = b;
  b.peer = a;
  return [a, b];
};

interface Install {
  readonly dir: string;
  readonly you: SwappableIdentity;
  readonly set: DeviceSet;
  readonly keys: ReturnType<typeof deviceKeys>;
  readonly name: string;
  readonly net: string[];
  readonly pinned: string[];
  settings: Settings;
  ao: AlwaysOn;
  readonly book: Map<string, MachineRecord>;
  cert?: DeviceCert;
}

/** One install of Beluga: its folder, identity, device set and Always On, with a stub network and the links to the others. */
function install(name: string, identity: Identity, others: () => readonly Install[], settings: Partial<Settings> = {}): Install {
  const dir = tmp();
  saveIdentity(path.join(dir, 'identity.json'), identity);
  return assemble({ dir, name, identity, keys: deviceKeys(newSeed()), settings: { ...settings } as Settings, book: new Map() }, others);
}

/** The same install started again (BLG-847): everything from its folder, as the daemon reads it at start, its links as before. */
function restart(was: Install, others: () => readonly Install[]): Install {
  const again = assemble({ dir: was.dir, name: was.name, identity: identitiesAtStart(was.dir).local, keys: was.keys, settings: was.settings, book: was.book }, others);
  if (was.cert) again.cert = was.cert;
  return again;
}

function assemble(from: { dir: string; name: string; identity: Identity; keys: ReturnType<typeof deviceKeys>; settings: Settings; book: Map<string, MachineRecord> }, others: () => readonly Install[]): Install {
  const { dir, name, keys } = from;
  const you = swappableIdentity(from.identity);
  const set = new DeviceSet({ file: path.join(dir, 'device-set.json'), keys, identity: you.identity, now });
  const me: Install = { dir, you, set, keys, name, net: [], pinned: [], settings: from.settings, ao: undefined as unknown as AlwaysOn, book: from.book };
  const machines = {
    set,
    book: { get: (id: string) => me.book.get(id) },
    drives: (r: MachineRecord) => me.book.has(deviceId(r.cert)),
    hereName: () => name,
    poll: () => Promise.resolve(),
    openLink: (r: MachineRecord): Promise<MessageSocket> => {
      const there = others().find((o) => o.cert && deviceId(o.cert) === deviceId(r.cert));
      if (!there) return Promise.reject(new Error(`${r.name} isn't reachable`));
      const [here, far] = pair();
      // What Machines.accept does on the computer: the first frame says it's a handover.
      far.once('message', (text: string) => there.ao.serve(far, set.self()!, text));
      return Promise.resolve(here);
    },
  } as unknown as Machines;
  me.ao = new AlwaysOn({
    dir,
    machines,
    you,
    network: () => ({ set: (on) => (me.net.push(on ? 'on' : 'off'), Promise.resolve()), rename: (n) => void me.net.push(`name:${n}`) }),
    settings: { load: () => me.settings, save: (patch) => void (me.settings = { ...me.settings, ...patch }) },
    pinAddress: (id) => void me.pinned.push(id.peerId),
    phones: () => [],
    stepMs: 2_000,
    retryMs: 60_000,
    now,
  });
  return me;
}

/** Your app (it holds your identity and friends network) and computers joined to it, each knowing the others. */
function world(computers: readonly string[] = ['Mac mini']) {
  const me = generateIdentity();
  const all: Install[] = [];
  const app = install('MacBook', me, () => all, { name: 'kayra', network: true, people: { 'mia-peer-1': { name: 'mia', trust: 'trusted' } }, askMeFor: 'reviews' } as Partial<Settings>);
  app.set.appCert('MacBook', 'macos');
  all.push(app);
  for (const n of computers) {
    const c = install(n, generateIdentity(), () => all, { name: 'server' } as Partial<Settings>);
    const cert = app.set.issue({ device: hex(c.keys.device.publicKey), link: hex(c.keys.link.publicKey), box: hex(c.keys.box.publicKey), name: n, platform: 'linux', role: 'computer' });
    c.set.joined(cert, app.set.add(cert));
    c.cert = cert;
    all.push(c);
  }
  // Every computer knows the app's latest set (what syncing does), and the app's own certificate for links back.
  for (const c of all.slice(1)) {
    c.set.merge(app.set.syncFrame());
    c.book.set(deviceId(app.set.self()!), { cert: app.set.self()!, address: '0'.repeat(64), relays: [], name: 'MacBook', pairedAt: 1 });
    app.book.set(deviceId(c.cert!), { cert: c.cert!, address: '1'.repeat(64), relays: [], name: c.name, pairedAt: 1 });
  }
  // Your friends network on the app.
  writeFileSync(path.join(app.dir, 'friends.json'), JSON.stringify({ friends: ['mia'] }));
  mkdirSync(path.join(app.dir, 'dms'));
  writeFileSync(path.join(app.dir, 'dms', 'mia.jsonl'), `${'{"text":"hi"}\n'.repeat(5_000)}`);
  mkdirSync(path.join(app.dir, 'groups', 'nested'), { recursive: true });
  writeFileSync(path.join(app.dir, 'groups', 'nested', 'g1.jsonl'), '');
  return { me, app, computers: all.slice(1) };
}

const peerIdIn = (dir: string): string | undefined => (existsSync(path.join(dir, 'identity.json')) ? loadIdentity(path.join(dir, 'identity.json')).peerId : undefined);

describe('Make Always On', () => {
  it('moves your identity, friends network and trust levels to the computer, and this install lets go', async () => {
    const { me, app, computers } = world();
    const [mini] = computers as [Install];
    const view = await app.ao.make(deviceId(mini.cert!));
    expect(view).toMatchObject({ here: false, id: deviceId(mini.cert!), name: 'Mac mini' });
    expect(view.pending).toBeUndefined();

    // The computer is you now: your identity on disk and in the running daemon, signing the set.
    expect(peerIdIn(mini.dir)).toBe(me.peerId);
    expect(mini.you.current().peerId).toBe(me.peerId);
    expect(mini.set.holdsIdentity).toBe(true);
    expect(readFileSync(path.join(mini.dir, 'friends.json'), 'utf8')).toBe(JSON.stringify({ friends: ['mia'] }));
    expect(readFileSync(path.join(mini.dir, 'dms', 'mia.jsonl'), 'utf8').length).toBe('{"text":"hi"}\n'.length * 5_000);
    expect(existsSync(path.join(mini.dir, 'groups', 'nested', 'g1.jsonl'))).toBe(true);
    expect(mini.settings).toMatchObject({ name: 'kayra', network: true, askMeFor: 'reviews', people: { 'mia-peer-1': { name: 'mia', trust: 'trusted' } } });
    expect(mini.net).toEqual(['name:kayra', 'on']);
    expect(readAlwaysOn(mini.dir)?.at).toBe('here');
    expect(existsSync(path.join(mini.dir, 'always-on-incoming'))).toBe(false);

    // This Mac: a stand-in key of its own, no network files, and it never starts the network itself.
    expect(app.net).toEqual(['off']);
    expect(app.you.current().peerId).not.toBe(me.peerId);
    expect(peerIdIn(app.dir)).not.toBe(me.peerId);
    expect(existsSync(path.join(app.dir, 'friends.json'))).toBe(false);
    expect(existsSync(path.join(app.dir, 'dms'))).toBe(false);
    expect(app.set.holdsIdentity).toBe(false);
    expect(app.set.owner().peerId).toBe(me.peerId);
    expect(networkElsewhere(app.dir)).toMatch(/runs on Mac mini/);
    // Both pinned their companion address as it was, so phones and computers reach them as before.
    expect(app.pinned).toEqual([me.peerId]);
    expect(mini.pinned).toHaveLength(1);
    expect(mini.pinned[0]).not.toBe(me.peerId);

    // The set the computer now signs still names every device, and the app takes its next one.
    const devices = app.set.devices().length;
    expect(mini.set.devices()).toHaveLength(devices);
    app.set.merge(mini.set.syncFrame());
    expect(app.set.devices()).toHaveLength(devices);
  });

  it('moves it back to this Mac the same way', async () => {
    const { me, app, computers } = world();
    const [mini] = computers as [Install];
    await app.ao.make(deviceId(mini.cert!));
    const view = await app.ao.make('here');
    expect(view.here).toBe(true);
    expect(app.you.current().peerId).toBe(me.peerId);
    expect(peerIdIn(app.dir)).toBe(me.peerId);
    expect(app.set.holdsIdentity).toBe(true);
    expect(readFileSync(path.join(app.dir, 'friends.json'), 'utf8')).toBe(JSON.stringify({ friends: ['mia'] }));
    expect(app.net).toEqual(['off', 'name:kayra', 'on']);
    expect(networkElsewhere(app.dir)).toBeUndefined();

    expect(mini.set.holdsIdentity).toBe(false);
    expect(mini.you.current().peerId).not.toBe(me.peerId);
    expect(existsSync(path.join(mini.dir, 'friends.json'))).toBe(false);
    expect(networkElsewhere(mini.dir)).toMatch(/runs on MacBook/);
    expect(mini.net).toEqual(['name:kayra', 'on', 'off']);
  });

  it('moves it from one computer to another, through this Mac, without starting it here', async () => {
    const { me, app, computers } = world(['Mac mini', 'build-box']);
    const [mini, aws] = computers as [Install, Install];
    await app.ao.make(deviceId(mini.cert!));
    const view = await app.ao.make(deviceId(aws.cert!));
    expect(view).toMatchObject({ here: false, name: 'build-box' });
    expect(aws.you.current().peerId).toBe(me.peerId);
    expect(aws.set.holdsIdentity).toBe(true);
    expect(mini.set.holdsIdentity).toBe(false);
    expect(app.set.holdsIdentity).toBe(false);
    // Off here the whole time: never two of you.
    expect(app.net.filter((n) => n === 'on')).toEqual([]);
    expect(peerIdIn(app.dir)).not.toBe(me.peerId);
  });

  it('changes nothing when the computer refuses it, and the network comes back on here', async () => {
    const { me, app, computers } = world();
    const [mini] = computers as [Install];
    // This computer now belongs to someone else's set: your identity isn't the one it takes.
    const stranger = generateIdentity();
    const other = install('stranger', stranger, () => []);
    const cert = other.set.issue({ device: hex(mini.keys.device.publicKey), link: hex(mini.keys.link.publicKey), box: hex(mini.keys.box.publicKey), name: 'Mac mini', platform: 'linux', role: 'computer' });
    mini.set.joined(cert, other.set.add(cert));
    await expect(app.ao.make(deviceId(mini.cert!))).rejects.toThrow(/isn’t the one this computer belongs to/);
    expect(app.you.current().peerId).toBe(me.peerId);
    expect(peerIdIn(app.dir)).toBe(me.peerId);
    expect(existsSync(path.join(app.dir, 'friends.json'))).toBe(true);
    expect(app.net).toEqual(['off', 'on']);
    expect(app.ao.view().here).toBe(true);
    expect(peerIdIn(mini.dir)).not.toBe(me.peerId);
    expect(existsSync(path.join(mini.dir, 'friends.json'))).toBe(false);
  });

  it('refuses a computer that isn’t one of yours, before anything moves', async () => {
    const { me, app } = world();
    await expect(app.ao.make('0123456789abcdef')).rejects.toThrow(/isn’t one of yours/);
    expect(app.net).toEqual([]);
    expect(peerIdIn(app.dir)).toBe(me.peerId);
  });

  it('only an app of yours moves it: a computer’s or phone’s link is turned away', () => {
    const { computers } = world();
    const [mini] = computers as [Install];
    const [, far] = pair();
    let closed: number | undefined;
    far.close = (code?: number) => void (closed = code);
    mini.ao.serve(far, mini.cert!, JSON.stringify({ t: 'always-on', op: 'give', stage: 'a'.repeat(32) }));
    expect(closed).toBe(4001);
  });
});

describe('the handover on the wire', () => {
  it('only carries the network’s own files: nothing outside them, nothing climbing out', () => {
    const part = (p: string) => parseAo(JSON.stringify({ t: 'ao-part', path: p, at: 0, data: '' }));
    expect(part('friends.json')).toBeDefined();
    expect(part('dms/mia.jsonl')).toBeDefined();
    expect(part('groups/nested/g1.jsonl')).toBeDefined();
    for (const bad of ['identity.json', 'settings.json', '../friends.json', 'dms/../../x', 'dms//x', '/etc/passwd', 'dms\\x', 'device-key.json', 'dms']) expect(part(bad)).toBeUndefined();
  });

  it('the identity arrives as the PEM identity.json keeps', () => {
    const me = generateIdentity();
    const dir = tmp();
    saveIdentity(path.join(dir, 'identity.json'), me);
    const pem = (JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')) as { privateKey: string }).privateKey;
    expect(identityFromPem(pem).peerId).toBe(me.peerId);
  });
});

describe('the device set when your identity moves', () => {
  it('your Always On keeps the phones this Mac paired, and this Mac remembers which were its own', () => {
    const me = generateIdentity();
    const app = new DeviceSet({ file: path.join(tmp(), 'device-set.json'), keys: deviceKeys(newSeed()), identity: me, now });
    const phoneKeys = deviceKeys(newSeed());
    const phone = app.issue({ device: hex(phoneKeys.device.publicKey), link: hex(phoneKeys.link.publicKey), box: hex(phoneKeys.box.publicKey), name: 'Pixel', platform: 'android', role: 'phone' });
    app.setPhones([phone]);
    const ck = deviceKeys(newSeed());
    const computerCert = app.issue({ device: hex(ck.device.publicKey), link: hex(ck.link.publicKey), box: hex(ck.box.publicKey), name: 'Mac mini', platform: 'linux', role: 'computer' });
    const you = swappableIdentity(generateIdentity());
    const mini = new DeviceSet({ file: path.join(tmp(), 'device-set.json'), keys: ck, identity: you.identity, now });
    mini.joined(computerCert, app.add(computerCert));

    app.release([phone.device]);
    mini.takeOver(app.syncFrame(), []);
    you.swap(me);
    expect(mini.holdsIdentity).toBe(true);
    // The computer has no phones of its own: the Mac's stays in the set.
    mini.setPhones([]);
    expect(mini.devices().some((c) => c.device === phone.device)).toBe(true);
  });
});

describe('this install’s address when your identity moves', () => {
  it('stays the one it had: pinned before the identity changes, whatever identity it holds after', async () => {
    const { companionKeyPair, pinCompanionSeed } = await import('../src/companion/host.js');
    const mine = generateIdentity();
    const file = path.join(tmp(), 'companion-seed.json');
    const before = await companionKeyPair(mine, file);
    pinCompanionSeed(file, mine);
    // Pinned once: a later pin with another identity doesn't move it.
    pinCompanionSeed(file, generateIdentity());
    const after = await companionKeyPair(generateIdentity(), file);
    expect(hex(after.publicKey)).toBe(hex(before.publicKey));
  });
});

describe('never two of you, never none (BLG-799)', () => {
  it('this Mac stands in from its replica while your Always On is down, and hands back what came, merged', async () => {
    const { me, app, computers } = world();
    const [mini] = computers as [Install];
    await app.ao.make(deviceId(mini.cert!));
    // This Mac keeps its own copy of your identity (it never leaves it) and a replica of the network.
    expect(peerIdIn(app.dir)).not.toBe(me.peerId);
    expect(loadIdentity(path.join(app.dir, 'identity-standby.json')).peerId).toBe(me.peerId);
    expect(app.ao.canStandIn()).toBe(false);
    expect(await app.ao.refreshStandby()).toBe(true);
    expect(app.ao.canStandIn()).toBe(true);
    expect(app.ao.holding()).toBe(false);

    // The Mac mini goes down with a message the replica didn't have yet.
    writeFileSync(path.join(mini.dir, 'dms', 'mia.jsonl'), `${readFileSync(path.join(mini.dir, 'dms', 'mia.jsonl'), 'utf8')}{"text":"before it went down"}\n`);
    await app.ao.standIn();
    expect(app.ao.holding()).toBe(true);
    expect(app.you.current().peerId).toBe(me.peerId);
    expect(app.ao.view()).toMatchObject({ here: true, standIn: { id: deviceId(mini.cert!), name: 'Mac mini' } });
    expect(app.net.at(-1)).toBe('on');
    expect(readFileSync(path.join(app.dir, 'friends.json'), 'utf8')).toBe(JSON.stringify({ friends: ['mia'] }));
    // Mia writes while this Mac stands in.
    writeFileSync(path.join(app.dir, 'dms', 'mia.jsonl'), `${readFileSync(path.join(app.dir, 'dms', 'mia.jsonl'), 'utf8')}{"text":"while it was away"}\n`);

    // It answers again: everything goes back, merged, and this Mac lets go.
    await app.ao.handBack();
    expect(app.ao.holding()).toBe(false);
    expect(app.ao.at()).toBe(deviceId(mini.cert!));
    expect(app.ao.view().standIn).toBeUndefined();
    expect(mini.ao.holding()).toBe(true);
    const log = readFileSync(path.join(mini.dir, 'dms', 'mia.jsonl'), 'utf8');
    expect(log).toContain('before it went down');
    expect(log).toContain('while it was away');
    expect(log.split('\n').filter(Boolean)).toHaveLength(5_002);
    // The Mac mini stopped its own network before taking it back: never two of you (and keeps its own name for it).
    expect(mini.net).toEqual(['name:kayra', 'on', 'off', 'on']);
  });

  it('an Always On that finds a newer you elsewhere stops, keeping your identity and files to stand in later', async () => {
    const { me, app, computers } = world();
    const [mini] = computers as [Install];
    await app.ao.make(deviceId(mini.cert!));
    const appId = deviceId(app.set.self()!);
    await mini.ao.standDown({ id: appId, name: 'MacBook' });
    expect(mini.ao.holding()).toBe(false);
    expect(mini.ao.at()).toBe(appId);
    expect(mini.net.at(-1)).toBe('off');
    expect(networkElsewhere(mini.dir)).toMatch(/runs on MacBook/);
    expect(mini.ao.leaseIdentity()?.peerId).toBe(me.peerId);
    expect(mini.ao.canStandIn()).toBe(true);
    // Standing in again from its own files (it's your Always On: no stand-in note).
    await mini.ao.standIn();
    expect(mini.ao.holding()).toBe(true);
    expect(mini.ao.view().standIn).toBeUndefined();
  });

  it('a replica is never your identity, and only an install that is you sends one', async () => {
    const { app, computers } = world();
    const [mini] = computers as [Install];
    // Not you yet: it says so.
    expect(await app.ao.refreshStandby()).toBe(false);
    await app.ao.make(deviceId(mini.cert!));
    expect(await app.ao.refreshStandby()).toBe(true);
    const staged = readdirSync(path.join(app.dir, 'always-on-standby'));
    expect(staged).toHaveLength(1);
    const end = JSON.parse(readFileSync(path.join(app.dir, 'always-on-standby', staged[0]!, 'end.json'), 'utf8')) as { identity: string; replica: boolean };
    expect(end).toMatchObject({ identity: '', replica: true });
    // A second one replaces the first.
    expect(await app.ao.refreshStandby()).toBe(true);
    expect(readdirSync(path.join(app.dir, 'always-on-standby'))).toHaveLength(1);
  });
});

describe('rooms on this Mac after a handover and a restart (BLG-846)', () => {
  it('a room hosted here and a friend’s room joined from here both see you, never the stand-in key', async () => {
    const { identitiesAtStart } = await import('../src/machines/identity-load.js');
    const { startHub } = await import('../src/net/hub.js');
    const { PeerClient } = await import('../src/net/peer-client.js');
    const { deriveKeys, generateSecret } = await import('../src/net/crypto.js');
    const { me, app, computers } = world();
    const [mini] = computers as [Install];
    await app.ao.make(deviceId(mini.cert!));
    // The daemon starts again: what it reads from disk now.
    const started = identitiesAtStart(app.dir);
    expect(started.local.peerId).not.toBe(me.peerId);
    expect(started.you.peerId).toBe(me.peerId);

    const profile = { name: 'kayra', shares: [], agent: false };
    const join = async (port: number, keys: ReturnType<typeof deriveKeys>, identity: Identity) => {
      const client = new PeerClient({ url: `ws://127.0.0.1:${port}`, keys, profile, identity, reconnect: false });
      const welcomed = new Promise<{ peerId: string; host?: boolean }>((resolve) => client.once('welcome', (you) => resolve(you)));
      client.connect();
      return { client, you: await welcomed };
    };

    // Hosting: the hub marks you as its host, and you are your own peer id.
    const hostKeys = deriveKeys(generateSecret());
    const hosted = await startHub({ keys: hostKeys, port: 0, host: '127.0.0.1', roomName: 'kayra', hostId: started.you.peerId });
    const mine = await join(hosted.port, hostKeys, started.you);
    expect(mine.you).toMatchObject({ peerId: me.peerId, host: true });
    mine.client.close();
    await hosted.close();

    // Joining mia's room: mia sees your own peer id, the one her trust levels are kept by.
    const mia = generateIdentity();
    const miaKeys = deriveKeys(generateSecret());
    const theirs = await startHub({ keys: miaKeys, port: 0, host: '127.0.0.1', roomName: 'mia', hostId: mia.peerId });
    const miaClient = await join(theirs.port, miaKeys, mia);
    const seenByMia = new Promise<string[]>((resolve) => miaClient.client.on('peers', (peers) => peers.length > 1 && resolve(peers.map((p) => p.peerId))));
    const joined = await join(theirs.port, miaKeys, started.you);
    expect(joined.you.peerId).toBe(me.peerId);
    expect(await seenByMia).toContain(me.peerId);
    expect(await seenByMia).not.toContain(started.local.peerId);
    joined.client.close();
    miaClient.client.close();
    await theirs.close();
  });

  it('an install that never handed its identity on uses identity.json for rooms, as before', async () => {
    const { identitiesAtStart } = await import('../src/machines/identity-load.js');
    const { me, app } = world();
    const started = identitiesAtStart(app.dir);
    expect(started.local.peerId).toBe(me.peerId);
    expect(started.you.peerId).toBe(me.peerId);
  });
});

describe('standing in and handing back keep your newest settings (BLG-848)', () => {
  const mia = 'mia-peer-1';
  const bob = 'bob-peer-22';
  const carol = 'carol-peer-3';

  it('stands in on the Always On’s newest trust levels and Ask Me For, and hands back only what changed meanwhile', async () => {
    const { app, computers } = world();
    const [mini] = computers as [Install];
    await app.ao.make(deviceId(mini.cert!));
    // On the Mac mini, before this Mac's replica: carol trusted fully, a new Ask Me For.
    mini.settings = { ...mini.settings, askMeFor: 'code reviews only', people: { ...mini.settings.people, [carol]: { name: 'carol', trust: 'full' } } };
    expect(await app.ao.refreshStandby()).toBe(true);
    // After the replica, just before it goes down: mia is asked about every time now. This Mac never sees that.
    mini.settings = { ...mini.settings, people: { ...mini.settings.people, [mia]: { name: 'mia', trust: 'ask' } } };

    await app.ao.standIn();
    // Standing in: the Mac mini's newest as of the replica, not what this Mac had at the handover.
    expect(app.settings.askMeFor).toBe('code reviews only');
    expect(app.settings.people[carol]).toEqual({ name: 'carol', trust: 'full' });
    expect(app.settings.people[mia]).toEqual({ name: 'mia', trust: 'trusted' });

    // While standing in, you trust bob and change Ask Me For.
    app.settings = { ...app.settings, askMeFor: 'anything', people: { ...app.settings.people, [bob]: { name: 'bob', trust: 'trusted' } } };
    await app.ao.handBack();
    expect(mini.ao.holding()).toBe(true);
    // What changed during the stand-in reached it…
    expect(mini.settings.people[bob]).toEqual({ name: 'bob', trust: 'trusted' });
    expect(mini.settings.askMeFor).toBe('anything');
    // …and what it changed itself, never seen here, survived.
    expect(mini.settings.people[mia]).toEqual({ name: 'mia', trust: 'ask' });
    expect(mini.settings.people[carol]).toEqual({ name: 'carol', trust: 'full' });
    expect(existsSync(path.join(app.dir, 'standin-settings.json'))).toBe(false);
  });

  it('a person forgotten during the stand-in is forgotten there too; an untouched setting is never sent', async () => {
    const { changesSince, applyChanges, beginStandIn } = await import('../src/machines/standin-settings.js');
    const dir = tmp();
    let mine: Partial<Settings> = {};
    beginStandIn(dir, { askMeFor: 'reviews', policy: 'ask', people: { [mia]: { name: 'mia', trust: 'trusted' }, [bob]: { name: 'bob', trust: 'ask' } } }, (p) => void (mine = { ...mine, ...p }), 1);
    const changes = changesSince(dir, { askMeFor: 'reviews', policy: 'ask', people: { [mia]: { name: 'mia', trust: 'trusted' } } }, 2);
    expect(changes).toEqual({ at: 2, settings: {}, people: { [bob]: null } });
    const theirs: Partial<Settings> = { askMeFor: 'their own', people: { [bob]: { name: 'bob', trust: 'ask' }, [carol]: { name: 'carol', trust: 'full' } } };
    expect(applyChanges(theirs, changes)).toEqual({ people: { [carol]: { name: 'carol', trust: 'full' } } });
    // A change that doesn't read as a setting is left as the Always On has it.
    expect(applyChanges(theirs, { at: 3, settings: { policy: 'whatever', askMeFor: 'ok' }, people: { [mia]: { name: 'mia', trust: 'superuser' } } })).toEqual({ askMeFor: 'ok', people: theirs.people });
  });
});

describe('standing in survives a restart (BLG-847)', () => {
  it('a Mac standing in is still you after a restart, runs your network, and still hands back to the same stand-in key', async () => {
    const { me, app: before, computers } = world();
    const [mini] = computers as [Install];
    const all: Install[] = [before, mini];
    await before.ao.make(deviceId(mini.cert!));
    const standInKey = before.you.current().peerId;
    expect(await before.ao.refreshStandby()).toBe(true);
    await before.ao.standIn();
    expect(before.ao.holding()).toBe(true);

    // The daemon starts again from disk.
    const app = restart(before, () => all);
    all[0] = app;
    expect(app.you.current().peerId).toBe(me.peerId);
    expect(app.set.holdsIdentity).toBe(true);
    expect(app.ao.holding()).toBe(true);
    expect(app.ao.standingIn()).toEqual({ id: deviceId(mini.cert!), name: 'Mac mini' });
    // The network may start here: it isn't elsewhere, and the lease is asked as you.
    expect(networkElsewhere(app.dir)).toBeUndefined();
    expect(app.ao.leaseIdentity()?.peerId).toBe(me.peerId);
    expect(identitiesAtStart(app.dir).you.peerId).toBe(me.peerId);

    // The Mac mini answers again: the lease round hands back, and this Mac is its own stand-in key once more.
    const { LeaseKeeper } = await import('../src/machines/lease.js');
    let lease: { v: 1; holder: string; name: string; at: number; seq: number } | undefined;
    const keeper = new LeaseKeeper({
      host: app.ao,
      board: { read: async () => lease, write: async (_, l, seq) => void (lease = { ...l, seq }) },
      self: () => ({ id: deviceId(app.set.self()!), name: 'MacBook' }),
      heard: () => undefined,
      reachable: async () => true,
    });
    await keeper.tick();
    expect(mini.ao.holding()).toBe(true);
    expect(app.ao.holding()).toBe(false);
    expect(app.you.current().peerId).toBe(standInKey);
    expect(identitiesAtStart(app.dir).local.peerId).toBe(standInKey);
    // Never two of you: one holder at every step.
    expect([app.ao.holding(), mini.ao.holding()].filter(Boolean)).toHaveLength(1);
  });

  it('never two of you across the restart: the Mac mini stays off while this Mac stands in', async () => {
    const { app: before, computers } = world();
    const [mini] = computers as [Install];
    const all: Install[] = [before, mini];
    await before.ao.make(deviceId(mini.cert!));
    expect(await before.ao.refreshStandby()).toBe(true);
    // The Mac mini went down; this Mac stands in; the Mac mini comes back and finds the lease says this Mac (standDown).
    await before.ao.standIn();
    await mini.ao.standDown({ id: deviceId(before.set.self()!), name: 'MacBook' });
    const app = restart(before, () => all);
    all[0] = app;
    expect([app.ao.holding(), mini.ao.holding()]).toEqual([true, false]);
    expect(networkElsewhere(mini.dir)).toMatch(/runs on MacBook/);
    await app.ao.handBack();
    expect([app.ao.holding(), mini.ao.holding()]).toEqual([false, true]);
  });
});
