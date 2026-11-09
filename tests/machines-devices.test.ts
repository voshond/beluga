import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CERT_LABEL, canonical, deviceKeys, hex, newSeed, parseComputerTicket, parseDeviceTicket, verifyCert } from '../src/companion/device-crypto.js';
import { DeviceBook, deviceId } from '../src/companion/devices.js';
import type { DeviceCert } from '../src/companion/protocol.js';
import { DeviceSet } from '../src/machines/controllers.js';
import { loadDeviceKeys } from '../src/machines/device-key.js';
import { type Identity, generateIdentity } from '../src/net/crypto.js';
import { signText } from '../src/net/mesh/keys.js';

/** Your devices, signed by you (BLG-774): roles, the device set, and forgetting from anywhere. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-devset-'));
  dirs.push(d);
  return d;
};

/** One clock for every install in a test: each reading is a millisecond later. */
let clock = 1_700_000_000_000;
const now = (): number => ++clock;

function install(identity: Identity = generateIdentity()) {
  const keys = deviceKeys(newSeed());
  const set = new DeviceSet({ file: path.join(tmp(), 'device-set.json'), keys, identity, now });
  return { identity, keys, set };
}

/** A phone certificate as phones have been given one since the start: no role at all. */
function oldPhoneCert(identity: Identity, name = 'Pixel 9'): DeviceCert {
  const k = deviceKeys(newSeed());
  const body = { v: 1 as const, owner: identity.peerId, ownerKey: identity.publicKey, device: hex(k.device.publicKey), link: hex(k.link.publicKey), box: hex(k.box.publicKey), name, platform: 'android' as const, issuedAt: now() };
  return { ...body, sig: signText(identity, CERT_LABEL, canonical(body)) };
}

/** A computer joined to `app`'s set, as join.ts leaves it. */
function joinTo(app: ReturnType<typeof install>, name: string) {
  const computer = install();
  const cert = app.set.issue({ device: hex(computer.keys.device.publicKey), link: hex(computer.keys.link.publicKey), box: hex(computer.keys.box.publicKey), name, platform: 'linux', role: 'computer' });
  const roster = app.set.add(cert);
  computer.set.joined(cert, roster);
  return { ...computer, cert };
}

/** Two installs swap what they know, both ways (what a sync link does). */
const swap = (a: DeviceSet, b: DeviceSet): void => {
  b.merge(a.syncFrame());
  a.merge(b.syncFrame());
};

describe('certificates carry a role', () => {
  it('phones paired before roles keep verifying, and their book still loads', () => {
    const me = generateIdentity();
    const cert = oldPhoneCert(me);
    expect(verifyCert(cert)).toBe(true);
    const file = path.join(tmp(), 'devices.json');
    writeFileSync(file, JSON.stringify([{ cert, pairedAt: cert.issuedAt, app: '1.4.0' }]));
    const book = new DeviceBook(file);
    expect(book.size).toBe(1);
    expect(book.byLink(cert.link)?.cert.name).toBe('Pixel 9');
  });

  it('a role must fit its platform: no phone on a Mac, no app on Android', () => {
    const { set } = install();
    const k = deviceKeys(newSeed());
    const keys = { device: hex(k.device.publicKey), link: hex(k.link.publicKey), box: hex(k.box.publicKey), name: 'x' };
    expect(() => set.issue({ ...keys, platform: 'android', role: 'app' })).toThrow(/role/);
    expect(() => set.issue({ ...keys, platform: 'macos', role: 'phone' })).toThrow(/role/);
    expect(() => set.issue({ ...keys, platform: 'macos' })).toThrow(/role/);
    expect(verifyCert(set.issue({ ...keys, platform: 'linux', role: 'computer' }))).toBe(true);
  });

  it('a role can’t be changed after signing', () => {
    const { set } = install();
    const app = set.appCert('MacBook', 'macos');
    expect(verifyCert({ ...app, role: 'computer' })).toBe(false);
    expect(verifyCert({ ...app, role: undefined, platform: 'android' })).toBe(false);
  });

  it('the phone book keeps phones only', () => {
    const { set } = install();
    const book = new DeviceBook(path.join(tmp(), 'devices.json'));
    expect(() => book.add(set.appCert('MacBook', 'macos'))).toThrow(/Only a phone/);
    expect(book.size).toBe(0);
  });
});

describe('a computer lets in the devices your identity signed, by role', () => {
  it('admits your app to drive it; a phone of yours never passes as an app', () => {
    const app = install();
    const appCert = app.set.appCert('MacBook', 'macos');
    const phone = oldPhoneCert(app.identity);
    app.set.setPhones([phone]);
    const mini = joinTo(app, 'mini');
    expect(mini.set.owner().peerId).toBe(app.identity.peerId);
    expect(mini.set.admit(appCert.link, ['app'])?.name).toBe('MacBook');
    expect(mini.set.admit(phone.link, ['app'])).toBeUndefined();
    expect(mini.set.admit(phone.link, ['app', 'computer'])).toBeUndefined();
    // It doesn't let itself in.
    expect(mini.set.admit(mini.cert.link, ['computer'])).toBeUndefined();
  });

  it('nobody else: another identity’s app, or a set someone else signed, gets nothing', () => {
    const app = install();
    app.set.appCert('MacBook', 'macos');
    const mini = joinTo(app, 'mini');
    const stranger = install();
    const theirs = stranger.set.appCert('Their Mac', 'macos');
    expect(mini.set.admit(theirs.link, ['app'])).toBeUndefined();
    // Their set naming their app, handed to this computer: refused (not its owner's).
    expect(mini.set.merge(stranger.set.syncFrame())).toEqual([]);
    expect(mini.set.admit(theirs.link, ['app'])).toBeUndefined();
    // A set that claims to be yours but carries their certificate: its signature breaks.
    const forged = { ...app.set.roster()!, seq: 99, devices: [...app.set.roster()!.devices, theirs] };
    mini.set.merge({ roster: forged, forgotten: [] });
    expect(mini.set.roster()!.seq).toBe(app.set.roster()!.seq);
    expect(mini.set.admit(theirs.link, ['app'])).toBeUndefined();
  });

  it('a second app you signed is let in once the set reaches the computer', () => {
    const app = install();
    app.set.appCert('MacBook', 'macos');
    const mini = joinTo(app, 'mini');
    const k = deviceKeys(newSeed());
    const second = app.set.issue({ device: hex(k.device.publicKey), link: hex(k.link.publicKey), box: hex(k.box.publicKey), name: 'iMac', platform: 'macos', role: 'app' });
    app.set.add(second);
    expect(mini.set.admit(second.link, ['app'])).toBeUndefined();
    swap(app.set, mini.set);
    expect(mini.set.admit(second.link, ['app'])?.name).toBe('iMac');
  });

  it('only the holder of your identity signs devices in', () => {
    const app = install();
    app.set.appCert('MacBook', 'macos');
    const mini = joinTo(app, 'mini');
    expect(mini.set.holdsIdentity).toBe(false);
    expect(() => mini.set.issue({ device: '0'.repeat(64), link: '1'.repeat(64), box: '2'.repeat(64), name: 'x', platform: 'linux', role: 'computer' })).toThrow(/holds your identity/);
  });
});

describe('forgetting a device on any of yours', () => {
  it('a phone forgotten on one computer is cut off on the app and every other computer', () => {
    const app = install();
    app.set.appCert('MacBook', 'macos');
    const phone = oldPhoneCert(app.identity);
    app.set.setPhones([phone]);
    const a = joinTo(app, 'mini');
    const b = joinTo(app, 'aws');
    swap(app.set, a.set);
    swap(app.set, b.set);
    expect(b.set.devices().map((d) => d.name)).toContain('Pixel 9');

    a.set.forget(deviceId(phone));
    // Cut off on that computer at once.
    expect(a.set.devices().map((d) => d.name)).not.toContain('Pixel 9');
    // The app hears it and signs the set again without the phone; then the other computer hears.
    const cutOnApp = app.set.merge(a.set.syncFrame());
    expect(cutOnApp.map((c) => c.name)).toEqual(['Pixel 9']);
    expect(app.set.roster()!.devices.map((d) => d.name)).not.toContain('Pixel 9');
    const cutOnB = b.set.merge(app.set.syncFrame());
    expect(cutOnB.map((c) => c.name)).toEqual(['Pixel 9']);
    // Everyone agrees, and hearing it again changes nothing.
    expect(b.set.merge(a.set.syncFrame())).toEqual([]);
    expect(app.set.merge(b.set.syncFrame())).toEqual([]);
  });

  it('a computer forgotten from another computer can no longer forget anything', () => {
    const app = install();
    const appCert = app.set.appCert('MacBook', 'macos');
    const a = joinTo(app, 'mini');
    const b = joinTo(app, 'aws');
    swap(app.set, a.set);
    swap(app.set, b.set);
    a.set.forget(deviceId(b.cert));
    swap(a.set, app.set);
    swap(app.set, b.set);
    expect(app.set.devices().map((d) => d.name)).toEqual(['MacBook', 'mini']);
    // b was let go: what it says now isn't taken, and it can't make a forget of its own.
    expect(() => b.set.forget(deviceId(appCert))).toThrow(/no longer one of yours/);
    expect(app.set.devices().map((d) => d.name)).toContain('MacBook');
  });

  it('a forget signed by a stranger is ignored', () => {
    const app = install();
    app.set.appCert('MacBook', 'macos');
    const phone = oldPhoneCert(app.identity);
    app.set.setPhones([phone]);
    const stranger = install();
    const fake = { device: phone.device, at: now(), by: hex(stranger.keys.device.publicKey), sig: 'A'.repeat(88) };
    expect(app.set.merge({ forgotten: [fake] })).toEqual([]);
    expect(app.set.devices().map((d) => d.name)).toContain('Pixel 9');
  });

  it('removing a phone on the Mac forgets it; pairing it again later lets it back', () => {
    const app = install();
    app.set.appCert('MacBook', 'macos');
    const mini = joinTo(app, 'mini');
    const phone = oldPhoneCert(app.identity);
    app.set.setPhones([phone]);
    swap(app.set, mini.set);
    app.set.setPhones([]);
    swap(app.set, mini.set);
    expect(mini.set.devices().map((d) => d.name)).not.toContain('Pixel 9');
    // The same phone paired again: a newer certificate for the same key.
    const again = { ...phone, issuedAt: now() };
    const body = { ...again } as Partial<DeviceCert>;
    delete body.sig;
    const fresh = { ...again, sig: signText(app.identity, CERT_LABEL, canonical(body)) };
    app.set.setPhones([fresh]);
    swap(app.set, mini.set);
    expect(mini.set.devices().map((d) => d.name)).toContain('Pixel 9');
  });
});

describe('the pieces', () => {
  it('this install’s device key is made once, kept 0600, and read back the same', () => {
    const file = path.join(tmp(), 'device-key.json');
    const one = loadDeviceKeys(file);
    const two = loadDeviceKeys(file);
    expect(hex(two.device.publicKey)).toBe(hex(one.device.publicKey));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a computer’s link is told apart from a phone’s', () => {
    expect(parseComputerTicket('beluga://computer#abcdefghijklmnopqrstuv?r=wss%3A%2F%2Fx.example')).toEqual({ via: 'link', secret: 'abcdefghijklmnopqrstuv', relay: 'wss://x.example' });
    expect(parseComputerTicket('beluga://device#abcdefghijklmnopqrstuv')).toBeUndefined();
    expect(parseComputerTicket('k7qm-4xpa-r2td')).toEqual({ via: 'code', code: 'K7QM4XPAR2TD' });
    expect(parseDeviceTicket('beluga://device#abcdefghijklmnopqrstuv')?.via).toBe('link');
  });
});
