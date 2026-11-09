import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceKeys, hex, newSeed } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { DEFAULT_PREFS, type Prefs } from '../src/core/store.js';
import { Machines } from '../src/machines/machines.js';
import { runOnHere } from '../src/machines/run-on.js';
import { SettingsSync } from '../src/machines/sync.js';
import { generateIdentity } from '../src/net/crypto.js';

/** Run New Work On means here on a computer (BLG-836): synced as you chose it, read where it applies. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-runon-'));
  dirs.push(d);
  return d;
};

const MINI = '0123456789abcdef';
const AWS = 'fedcba9876543210';
const app = { role: 'app' as const, id: 'aaaaaaaaaaaaaaaa', computers: [MINI, AWS] };

describe('runOnHere', () => {
  it('on a computer, it always means here', () => {
    const computer = { role: 'computer' as const, id: MINI, computers: [] };
    for (const v of ['here', 'best', MINI, AWS, '1111111111111111']) expect(runOnHere(v, computer)).toBe('here');
  });

  it('on any device, naming itself or a computer it doesn’t know means here', () => {
    expect(runOnHere(app.id, app)).toBe('here');
    expect(runOnHere('1111111111111111', app)).toBe('here');
    expect(runOnHere(MINI, { ...app, id: MINI })).toBe('here');
  });

  it('on your app, here, best and a computer it knows stay as chosen', () => {
    expect(runOnHere('here', app)).toBe('here');
    expect(runOnHere('best', app)).toBe('best');
    expect(runOnHere(AWS, app)).toBe(AWS);
  });
});

function machines(dir: string, keys = deviceKeys(newSeed())) {
  return new Machines({
    dir,
    identity: generateIdentity(),
    keys,
    devices: new DeviceBook(path.join(dir, 'devices.json')),
    node: () => Promise.reject(new Error('no network in this test')),
    address: () => '00',
    relayUrl: () => undefined,
    name: () => 'x',
    version: '0.9.0',
    removePhone: () => undefined,
  });
}

describe('this device as Run New Work On reads it', () => {
  it('your app reads as the app; a computer joined to it reads as a computer', () => {
    const mac = machines(tmp());
    const boxKeys = deviceKeys(newSeed());
    const box = machines(tmp(), boxKeys);
    expect(mac.runOnDevice()).toMatchObject({ role: 'app', id: hex(mac.keys.device.publicKey).slice(0, 16), computers: [] });
    const cert = mac.set.issue({ device: hex(boxKeys.device.publicKey), link: hex(boxKeys.link.publicKey), box: hex(boxKeys.box.publicKey), name: 'build-box', platform: 'linux', role: 'computer' });
    box.set.joined(cert, mac.set.add(cert));
    const device = box.runOnDevice();
    expect(device.role).toBe('computer');
    expect(runOnHere(device.id, device)).toBe('here');
  });

  it('the synced value stays as your app chose it on the computer', () => {
    const dir = tmp();
    let prefs: Prefs = { ...DEFAULT_PREFS };
    const listeners = new Set<() => void>();
    const sync = new SettingsSync({
      file: path.join(dir, 'settings-sync.json'),
      prefs: () => prefs,
      watch: (l) => (listeners.add(l), () => void listeners.delete(l)),
      apply: (patch) => {
        prefs = { ...prefs, ...(patch as Partial<Prefs>) };
        for (const l of [...listeners]) l();
      },
    });
    sync.start({ self: () => ({ id: MINI, name: 'mini' }), push: () => undefined });
    sync.merge({ id: app.id, name: 'MacBook', role: 'app' }, { entries: { runOn: { at: Date.now() + 1000, by: app.id, name: 'MacBook', value: MINI } } }, false);
    expect(prefs.runOn).toBe(MINI);
    expect(runOnHere(prefs.runOn, { role: 'computer', id: MINI, computers: [] })).toBe('here');
    // Reading it changed nothing: the computer still says your app's choice back.
    expect(prefs.runOn).toBe(MINI);
    expect(sync.frame({ id: app.id }, false).entries.runOn).toMatchObject({ value: MINI, by: app.id });
    sync.stop();
  });
});
