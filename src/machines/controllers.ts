import { z } from 'zod';
import { CERT_LABEL, type DeviceKeys, FORGET_LABEL, ROSTER_LABEL, canonical, forgetText, hex, roleOf, signWith, verifyCert, verifyForget, verifyRoster } from '../companion/device-crypto.js';
import { deviceId } from '../companion/devices.js';
import { DeviceCert, type DeviceRole, DeviceRoster, type DeviceSetSync, Forget, MAX_FORGOTTEN, MAX_SET_DEVICES } from '../companion/protocol.js';
import type { Identity } from '../net/crypto.js';
import { readJson, writeJson } from '../net/mesh/files.js';
import { signText } from '../net/mesh/keys.js';

/**
 * Your device set (BLG-774), as this install keeps it in ~/.beluga/device-set.json (0600): every
 * device your identity signed (phones, apps, computers), who was forgotten, and this install's own
 * certificate once it has one.
 *
 * Whoever holds your identity keeps the set: it signs each certificate and the set as a whole
 * (`seq` only grows) and hands it to every computer. A computer keeps the newest set its owner
 * signed and lets in exactly the devices in it, each with its role's limits (`admit`).
 *
 * Forgetting works from any device of yours: a forget is signed by your identity or by the device
 * key of an app or computer in the set, takes effect where it's made at once, and travels with
 * every sync (`syncFrame` / `merge`) until all of them have it. Forgets only accumulate, so the
 * set converges whichever way they travel; a device paired again later gets a newer certificate.
 */

const Owner = z.object({ peerId: z.string().min(1).max(200), key: z.string().max(200) });
type Owner = z.infer<typeof Owner>;

const SetFile = z.object({
  v: z.literal(1),
  owner: Owner.optional(),
  self: DeviceCert.optional(),
  roster: DeviceRoster.optional(),
  forgotten: z.array(Forget).max(MAX_FORGOTTEN).default([]),
  /** The phones paired on this install (their device keys), once your identity has been on more than one (BLG-796); unset: every phone in the set. */
  phonesHere: z.array(z.string().max(200)).max(64).optional(),
});
type SetFile = z.infer<typeof SetFile>;

/** A device of the set as `beluga computers` and Settings show it (never keys). */
export interface SetDeviceView {
  readonly id: string;
  readonly name: string;
  readonly role: DeviceRole;
  readonly platform: DeviceCert['platform'];
  readonly issuedAt: number;
  /** This install itself. */
  readonly self: boolean;
}

export interface DeviceSetOptions {
  readonly file: string;
  /** This install's own keys (device-key.ts). */
  readonly keys: DeviceKeys;
  /** This install's identity: it keeps the set while nobody else owns this install. */
  readonly identity: Identity;
  readonly now?: () => number;
}

/** Whether `f` covers `cert`: the same device, forgotten at or after it was signed. */
const covers = (f: Forget, cert: Pick<DeviceCert, 'device' | 'issuedAt'>): boolean => f.device === cert.device && f.at >= cert.issuedAt;

export class DeviceSet {
  private state: SetFile;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly opts: DeviceSetOptions) {
    this.now = opts.now ?? Date.now;
    const parsed = SetFile.safeParse(readJson(opts.file));
    this.state = parsed.success ? parsed.data : { v: 1, forgotten: [] };
  }

  /** Whose set this install is in: its own identity's until a computer pairing makes it someone's. */
  owner(): Owner {
    return this.state.owner ?? { peerId: this.opts.identity.peerId, key: this.opts.identity.publicKey };
  }

  /** This install signs the set (it holds the owner's identity). */
  get holdsIdentity(): boolean {
    return this.owner().peerId === this.opts.identity.peerId;
  }

  self(): DeviceCert | undefined {
    return this.state.self;
  }

  roster(): DeviceRoster | undefined {
    return this.state.roster;
  }

  forgotten(): readonly Forget[] {
    return this.state.forgotten;
  }

  /** A certificate still holds: it's in the set and nobody forgot it since it was signed. */
  holds(cert: DeviceCert): boolean {
    return !this.state.forgotten.some((f) => covers(f, cert));
  }

  /** The devices of the set that still hold. */
  devices(): readonly DeviceCert[] {
    return (this.state.roster?.devices ?? []).filter((c) => this.holds(c));
  }

  /**
   * Who a Noise key belongs to, if it may come in with one of `roles` (the firewall's question).
   * Only certificates in the owner's set, never forgotten, never this install's own.
   */
  admit(linkHex: string, roles: readonly DeviceRole[]): DeviceCert | undefined {
    const self = this.state.self;
    return this.devices().find((c) => c.link === linkHex && roles.includes(roleOf(c)) && c.device !== self?.device);
  }

  views(): SetDeviceView[] {
    const self = this.state.self?.device;
    return this.devices().map((c) => ({ id: deviceId(c), name: c.name, role: roleOf(c), platform: c.platform, issuedAt: c.issuedAt, self: c.device === self }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  // ---- the holder of your identity

  /** Sign a certificate for a device (the holder only). */
  issue(unsigned: Omit<DeviceCert, 'sig' | 'owner' | 'ownerKey' | 'issuedAt' | 'v'>): DeviceCert {
    const identity = this.mustHold();
    const body: Omit<DeviceCert, 'sig'> = { v: 1, owner: identity.peerId, ownerKey: identity.publicKey, ...unsigned, issuedAt: this.now() };
    const cert: DeviceCert = { ...body, sig: signText(identity, CERT_LABEL, canonical(body)) };
    if (!verifyCert(cert)) throw new Error('That device’s role doesn’t fit its platform');
    return cert;
  }

  /** This install's own certificate as an app of your set, made the first time it drives a computer. */
  appCert(name: string, platform: 'macos' | 'linux' | 'windows'): DeviceCert {
    const current = this.state.self;
    if (current && roleOf(current) === 'app' && current.owner === this.owner().peerId && this.holds(current) && current.name === name.slice(0, 64)) return current;
    const { keys } = this.opts;
    const cert = this.issue({ device: hex(keys.device.publicKey), link: hex(keys.link.publicKey), box: hex(keys.box.publicKey), name: name.slice(0, 64), platform, role: 'app' });
    this.state = { ...this.state, self: cert };
    this.resign([...this.others(cert), cert]);
    return cert;
  }

  /** Add a device the holder signed (a computer joining); the same device again replaces its old certificate. */
  add(cert: DeviceCert): DeviceRoster {
    this.mustHold();
    if (!verifyCert(cert) || cert.owner !== this.owner().peerId) throw new Error('That certificate isn’t one your identity signed');
    const rest = this.others(cert);
    if (rest.length >= MAX_SET_DEVICES) throw new Error(`You have ${MAX_SET_DEVICES} devices; forget one first`);
    return this.resign([...rest, cert]);
  }

  /**
   * The phones this install paired (devices.json): they join the set; one that went is forgotten.
   * Phones paired on another install that held your identity (before it became, or stopped being,
   * your Always On) stay as they are.
   */
  setPhones(phones: readonly DeviceCert[]): void {
    if (!this.holdsIdentity) return;
    const mine = phones.filter((p) => p.owner === this.owner().peerId && verifyCert(p) && roleOf(p) === 'phone');
    const here = this.state.phonesHere;
    const ours = (c: DeviceCert): boolean => here === undefined || here.includes(c.device);
    const current = this.devices().filter((c) => roleOf(c) === 'phone');
    // A phone paired again has a newer certificate for the same key: it's replaced, not forgotten.
    const gone = current.filter((c) => ours(c) && !mine.some((p) => p.device === c.device));
    const fresh = mine.filter((p) => this.holds(p) && !current.some((c) => c.device === p.device && c.issuedAt === p.issuedAt));
    const replaced = current.some((c) => ours(c) && !mine.some((p) => p.device === c.device && p.issuedAt === c.issuedAt));
    const nextHere = mine.map((p) => p.device).sort();
    const hereChanged = here !== undefined && nextHere.join() !== [...here].sort().join();
    if (!gone.length && !fresh.length && !replaced) {
      if (!hereChanged) return;
      this.state = { ...this.state, phonesHere: nextHere };
      writeJson(this.opts.file, this.state);
      return;
    }
    const forgets = gone.map((c) => this.forgetBody(c.device));
    const elsewhere = current.filter((c) => !ours(c) && !mine.some((p) => p.device === c.device));
    this.state = { ...this.state, forgotten: this.capped([...this.state.forgotten, ...forgets]), ...(here !== undefined ? { phonesHere: nextHere } : {}) };
    this.resign([...this.devices().filter((c) => roleOf(c) !== 'phone'), ...elsewhere.filter((c) => this.holds(c)), ...mine.filter((p) => this.holds(p))]);
  }

  // ---- your identity moving between installs (BLG-796, always-on.ts)

  /**
   * Your identity is leaving this install: whose set this is stays pinned (the owner it had), and the
   * phones paired here are remembered as this install's, so a later return knows them from the others.
   */
  release(phonesHere: readonly string[]): void {
    this.state = { ...this.state, owner: this.owner(), phonesHere: [...phonesHere].sort() };
    writeJson(this.opts.file, this.state);
  }

  /**
   * Your identity is arriving here: first the newest set the giver knew (signed by your identity, so
   * merged before this install holds it), and phones are this install's own from now on.
   */
  takeOver(devset: Pick<DeviceSetSync, 'roster' | 'forgotten'>, phonesHere: readonly string[]): void {
    this.merge(devset);
    this.state = { ...this.state, owner: this.owner(), phonesHere: [...phonesHere].sort() };
    writeJson(this.opts.file, this.state);
  }

  // ---- anyone in the set

  /**
   * Forget a device (by its id or key), from here: signed by your identity where it's held, else
   * by this install's own device key. It's refused here at once and everywhere the sync reaches.
   */
  forget(which: string): Forget {
    const cert = this.devices().find((c) => c.device === which || deviceId(c) === which);
    if (!cert) throw new Error('No device of yours has that id');
    const f = this.forgetBody(cert.device);
    this.state = { ...this.state, forgotten: this.capped([...this.state.forgotten, f]) };
    if (this.holdsIdentity) this.resign(this.devices());
    else this.save();
    return f;
  }

  /** What this install tells another of yours: the set it has (when it has one) and every forget it knows. */
  syncFrame(): DeviceSetSync {
    return { t: 'devset', ...(this.state.roster ? { roster: this.state.roster } : {}), forgotten: [...this.state.forgotten] };
  }

  /**
   * Take what another device of yours said: a newer set your identity signed, and forgets signed by
   * your identity or by an app or computer in the set. Returns the devices it newly cut off.
   */
  merge(sync: Pick<DeviceSetSync, 'roster' | 'forgotten'>): DeviceCert[] {
    const before = this.devices();
    const owner = this.owner();
    let next = this.state;
    const r = sync.roster;
    if (r && !this.holdsIdentity && r.owner === owner.peerId && r.ownerKey === owner.key && r.seq > (next.roster?.seq ?? 0) && verifyRoster(r)) next = { ...next, roster: r };
    const signers = new Set((next.roster?.devices ?? []).filter((c) => roleOf(c) !== 'phone' && !next.forgotten.some((f) => covers(f, c))).map((c) => c.device));
    const known = new Set(next.forgotten.map((f) => `${f.device}:${f.at}`));
    const fresh = sync.forgotten.filter((f) => !known.has(`${f.device}:${f.at}`) && (f.by === 'identity' || signers.has(f.by)) && verifyForget(f, owner.key));
    // A newer set carries its own forgets too.
    const carried = (next.roster?.forgotten ?? []).filter((f) => !known.has(`${f.device}:${f.at}`) && verifyForget(f, owner.key));
    if (next === this.state && !fresh.length && !carried.length) return [];
    this.state = { ...next, forgotten: this.capped([...next.forgotten, ...fresh, ...carried]) };
    if (this.holdsIdentity) this.resign(this.devices());
    else this.save();
    const now = new Set(this.devices().map((c) => c.device));
    return before.filter((c) => !now.has(c.device));
  }

  /**
   * A computer joined a set (pairing, join.ts): its owner, its own certificate and the set, which
   * must hold that certificate. Phones this install paired itself are its own business.
   */
  joined(cert: DeviceCert, roster: DeviceRoster): void {
    if (!verifyRoster(roster) || !verifyCert(cert) || roleOf(cert) !== 'computer') throw new Error('That device set doesn’t check out');
    if (cert.owner !== roster.owner || !roster.devices.some((c) => c.device === cert.device && c.sig === cert.sig)) throw new Error('That device set doesn’t name this computer');
    const { keys } = this.opts;
    if (cert.device !== hex(keys.device.publicKey) || cert.link !== hex(keys.link.publicKey)) throw new Error('That certificate is for another computer');
    const sameOwner = this.state.owner?.peerId === roster.owner;
    this.state = { v: 1, owner: { peerId: roster.owner, key: roster.ownerKey }, self: cert, roster, forgotten: sameOwner ? this.state.forgotten : [...roster.forgotten] };
    this.save();
  }

  // ---- inside

  private mustHold(): Identity {
    if (!this.holdsIdentity) throw new Error('Only the Beluga that holds your identity signs devices in');
    return this.opts.identity;
  }

  private forgetBody(device: string): Forget {
    const at = this.now();
    if (this.holdsIdentity) {
      const body = { device, at, by: 'identity' as const };
      return { ...body, sig: signText(this.opts.identity, FORGET_LABEL, canonical(body)) };
    }
    const self = this.state.self;
    if (!self || !this.holds(self) || roleOf(self) === 'phone') throw new Error('This computer is no longer one of yours');
    const body = { device, at, by: self.device };
    return { ...body, sig: signWith(this.opts.keys.device.secretKey, forgetText(body)) };
  }

  /** The set without `cert`'s device or link (replaced when it comes again). */
  private others(cert: DeviceCert): DeviceCert[] {
    return this.devices().filter((c) => c.device !== cert.device && c.link !== cert.link);
  }

  /** Sign the set again with these devices (the holder), seq one higher. */
  private resign(devices: readonly DeviceCert[]): DeviceRoster {
    const identity = this.mustHold();
    const body: Omit<DeviceRoster, 'sig'> = {
      v: 1,
      owner: identity.peerId,
      ownerKey: identity.publicKey,
      seq: (this.state.roster?.seq ?? 0) + 1,
      issuedAt: this.now(),
      devices: devices.filter((c) => this.holds(c)).slice(-MAX_SET_DEVICES),
      forgotten: this.state.forgotten,
    };
    const roster: DeviceRoster = { ...body, sig: signText(identity, ROSTER_LABEL, canonical(body)) };
    this.state = { ...this.state, roster };
    this.save();
    return roster;
  }

  /** Forgets, one per device and time, the newest MAX_FORGOTTEN. */
  private capped(list: readonly Forget[]): Forget[] {
    const seen = new Map<string, Forget>();
    for (const f of list) seen.set(`${f.device}:${f.at}`, f);
    return [...seen.values()].sort((a, b) => a.at - b.at).slice(-MAX_FORGOTTEN);
  }

  private save(): void {
    writeJson(this.opts.file, this.state);
    for (const l of [...this.listeners]) l();
  }
}
