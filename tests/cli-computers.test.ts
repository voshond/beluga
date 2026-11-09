import { describe, expect, it } from 'vitest';
import { type ComputersLink, addComputer, addOverSsh, forgetDevice, listComputers } from '../src/cli/computers.js';
import type { Io } from '../src/cli/io.js';
import { type ComputerPairLink, pairComputer } from '../src/cli/pair.js';
import type { SetDeviceView } from '../src/machines/controllers.js';

/** `beluga pair --computer` and `beluga computers` (BLG-774), against fakes of the daemon's machines.* methods. */

function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

const LINK = 'beluga://computer#abcdefghijklmnopqrstuv';
const FP = '🐶 🚀 🍒 ⚓';

/** A pairing that goes through `steps`, one per look. */
function pairing(steps: Array<Awaited<ReturnType<ComputerPairLink['status']>>>): ComputerPairLink & { cancelled: boolean } {
  let i = 0;
  const link = {
    cancelled: false,
    start: async () => ({ link: LINK, code: 'K7QM-4XPA-R2TD', expiresAt: Date.now() + 600_000 }),
    status: async () => steps[Math.min(i++, steps.length - 1)]!,
    cancel: async () => void (link.cancelled = true),
  };
  return link;
}

const open = { link: LINK, code: 'K7QM-4XPA-R2TD', expiresAt: Date.now() + 600_000 };

describe('beluga pair --computer', () => {
  it('prints a link, a code and a QR, then the app’s pictures, then that it joined', async () => {
    const io = capture();
    const link = pairing([{ open }, { open: { ...open, waiting: { name: 'MacBook', fingerprint: FP } } }, { open: { ...open, waiting: { name: 'MacBook', fingerprint: FP } } }, { last: { kind: 'joined', app: 'MacBook' } }]);
    expect(await pairComputer(link, io, { tty: false, columns: 200, pollMs: 1 })).toBe(0);
    const text = io.text();
    expect(text).toContain(LINK);
    expect(text).toContain('K7QM-4XPA-R2TD');
    expect(text).toContain('Or scan it:');
    expect(text).toContain('for 10:00');
    // The pictures are said once, however often it looks.
    expect(text.split(FP)).toHaveLength(2);
    expect(text).toContain('“MacBook” wants to add this computer');
    expect(text).toContain('Joined: this computer is now one of your devices, driven from MacBook');
  });

  it('--json says each step on its own line, for an SSH pairing to read', async () => {
    const io = capture();
    const link = pairing([{ open: { ...open, waiting: { name: 'MacBook', fingerprint: FP } } }, { last: { kind: 'joined', app: 'MacBook' } }]);
    expect(await pairComputer(link, io, { tty: false, json: true, pollMs: 1 })).toBe(0);
    const lines = io.text().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ link: LINK, code: 'K7QM-4XPA-R2TD' });
    expect(lines[1]).toEqual({ waiting: 'MacBook', fingerprint: FP });
    expect(lines[2]).toEqual({ end: 'joined', app: 'MacBook' });
  });

  it('says when it expired or the app said no', async () => {
    const expired = capture();
    expect(await pairComputer(pairing([{ last: { kind: 'expired' } }]), expired, { tty: false, pollMs: 1 })).toBe(1);
    expect(expired.errors()).toContain('expired');
    const declined = capture();
    expect(await pairComputer(pairing([{ last: { kind: 'declined' } }]), declined, { tty: false, pollMs: 1 })).toBe(1);
    expect(declined.errors()).toContain('The app said no');
  });

  it('Ctrl+C closes the pairing', async () => {
    const io = capture();
    const ctrlC = new AbortController();
    const link = pairing([{ open }]);
    const done = pairComputer(link, io, { tty: false, pollMs: 5, signal: ctrlC.signal });
    setTimeout(() => ctrlC.abort(), 20);
    expect(await done).toBe(130);
    expect(link.cancelled).toBe(true);
  });
});

const dev = (over: Partial<SetDeviceView>): SetDeviceView => ({ id: '0123456789abcdef', name: 'x', role: 'app', platform: 'macos', issuedAt: Date.now() - 3_600_000, self: false, ...over });

function computers(devices: SetDeviceView[], joins: { offer?: Error; approve?: Error } = {}): ComputersLink & { forgot: string[]; cancelled: number; approved: number } {
  const link = {
    forgot: [] as string[],
    cancelled: 0,
    approved: 0,
    list: async () => [{ id: 'aaaaaaaaaaaaaaaa', name: 'mini', platform: 'linux' as const, version: '0.9.0', pairedAt: Date.now() - 60_000, lastSeen: Date.now() - 60_000, status: 'offline' as const, skew: 'same' as const }],
    devices: async () => devices,
    forget: async (id: string) => {
      link.forgot.push(id);
      return { forgotten: id };
    },
    joinStart: async () => {
      if (joins.offer) throw joins.offer;
      return { name: 'mini', platform: 'linux' as const, version: '0.9.0', fingerprint: FP };
    },
    joinApprove: async () => {
      if (joins.approve) throw joins.approve;
      link.approved += 1;
      return { id: 'aaaaaaaaaaaaaaaa', name: 'mini', platform: 'linux' as const, pairedAt: Date.now(), status: 'unknown' as const, skew: 'same' as const };
    },
    joinCancel: async () => void (link.cancelled += 1),
    sshPair: async (host: string) => ({ name: host, platform: 'linux' as const, version: '0.9.0', fingerprint: FP, sshChecked: true }),
  };
  return link;
}

describe('beluga computers', () => {
  it('lists who may drive this computer, your computers and the rest of your set', async () => {
    const io = capture();
    const devices = [dev({ name: 'MacBook' }), dev({ id: 'bbbbbbbbbbbbbbbb', name: 'this one', role: 'computer', platform: 'linux', self: true }), dev({ id: 'cccccccccccccccc', name: 'Pixel 9', role: 'phone', platform: 'android' })];
    expect(await listComputers(computers(devices), io)).toBe(0);
    const text = io.text();
    expect(text).toMatch(/May drive this computer:\n {2}MacBook {2}Beluga app on Mac, signed in 1 ?h(our)? ago/);
    expect(text).toContain('Your computers:\n  mini  Linux · Beluga 0.9.0, offline, last seen 1 min');
    expect(text).toContain('Your other devices:\n  Pixel 9  phone on Android');
    expect(text).not.toContain('this one');
  });

  it('forget takes a name or an id, never this computer itself', async () => {
    const devices = [dev({ name: 'MacBook' }), dev({ id: 'bbbbbbbbbbbbbbbb', name: 'mini', role: 'computer', platform: 'linux', self: true })];
    const link = computers(devices);
    const io = capture();
    expect(await forgetDevice(link, 'macbook', io)).toBe(0);
    expect(link.forgot).toEqual(['0123456789abcdef']);
    expect(io.text()).toContain('Forgot MacBook');
    const self = capture();
    expect(await forgetDevice(link, 'mini', self)).toBe(1);
    expect(self.errors()).toContain('That’s this computer');
    const none = capture();
    expect(await forgetDevice(link, 'nope', none)).toBe(1);
    expect(none.errors()).toContain('None of your devices is called “nope”');
  });

  it('add shows the computer’s pictures and adds it on yes', async () => {
    const link = computers([]);
    const io = capture();
    expect(await addComputer(link, LINK, io, { ask: async () => 'y' })).toBe(0);
    expect(io.text()).toContain(`Check it shows these same four pictures: ${FP}`);
    expect(io.text()).toContain('Added mini');
    expect(link.approved).toBe(1);
  });

  it('add on no tells the computer no; an unreachable one is said plainly', async () => {
    const link = computers([]);
    const io = capture();
    expect(await addComputer(link, LINK, io, { ask: async () => 'n' })).toBe(1);
    expect(link.cancelled).toBe(1);
    expect(link.approved).toBe(0);
    const gone = capture();
    expect(await addComputer(computers([], { offer: new Error('That computer isn’t answering.') }), LINK, gone, { ask: async () => 'y' })).toBe(1);
    expect(gone.errors()).toContain('isn’t answering');
  });

  it('connect --pair adds it over SSH, saying the pictures matched there too', async () => {
    const link = computers([]);
    const io = capture();
    expect(await addOverSsh(link, 'kayra@mini', io, { ask: async () => 'yes' })).toBe(0);
    expect(io.errors()).toContain('Adding kayra@mini over SSH');
    expect(io.text()).toContain(`It printed these same four pictures over SSH: ${FP}`);
    expect(link.approved).toBe(1);
  });
});
