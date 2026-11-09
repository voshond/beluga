import { roleOf } from '../companion/device-crypto.js';
import { DeviceRecord, deviceId, isPhoneCert } from '../companion/devices.js';
import { readJson, writeJson } from '../net/mesh/files.js';
import { type DeviceCert, MAX_PHONE_COMPUTERS, type PhoneComputer } from '../companion/protocol.js';
import type { MachineRecord } from './book.js';
import type { MachineView } from './machines.js';
import { statusLine, whyNot } from './words.js';

/**
 * Your phones on your computers (BLG-809): a phone reaches each computer of yours by itself, with
 * the certificate it already has, so work goes on from the phone while this Mac sleeps.
 *
 * Two halves. Your app tells its phones where each computer is (its companion address and relays,
 * the `computers` frame, protocol 1.46), and again when one joins or changes. Each computer lets in
 * a phone of your device set as the Mac that paired it does: through the companion host's phone
 * door, with the phone table's limits (src/companion/coverage.ts), never an app's. It keeps no
 * record of it on disk (devices.json is for phones paired on that install), and a phone forgotten
 * anywhere is cut off there as the set reaches it.
 */

/** A phone of your set that wasn't paired on this install: known from the set's certificate only. */
export function setPhoneRecord(cert: DeviceCert): DeviceRecord | undefined {
  return isPhoneCert(cert) ? { cert, pairedAt: cert.issuedAt } : undefined;
}

type Push = NonNullable<DeviceRecord['push']>;
const Push = DeviceRecord.shape.push.unwrap();

/**
 * Where to push to the phones of your set on this install (BLG-850): a phone paired elsewhere
 * registers its push token with your Always On over its own link, kept here (~/.beluga/phone-push.json,
 * 0600; devices.json keeps those of phones paired here). Only phones still in your set.
 */
export class PhonePushes {
  private map: Readonly<Record<string, Push>>;

  constructor(private readonly file: string) {
    const raw = readJson(file);
    const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : [];
    this.map = Object.fromEntries(entries.flatMap(([id, v]) => {
      const p = Push.safeParse(v);
      return /^[0-9a-f]{16}$/.test(id) && p.success ? [[id, p.data]] : [];
    }));
  }

  get(id: string): Push | undefined {
    return this.map[id];
  }

  set(id: string, push: Push): void {
    this.save({ ...this.map, [id]: push });
  }

  /** Only the phones in `ids` keep theirs (one forgotten loses it). */
  keepOnly(ids: ReadonlySet<string>): void {
    const kept = Object.fromEntries(Object.entries(this.map).filter(([id]) => ids.has(id)));
    if (Object.keys(kept).length !== Object.keys(this.map).length) this.save(kept);
  }

  private save(next: Readonly<Record<string, Push>>): void {
    this.map = next;
    writeJson(this.file, next);
  }
}

/** How many phones a companion key's relay record names (RelayRecord.phones). */
const NAMED_MAX = 8;

/**
 * The phones a companion key's relay record names (their link keys' first 16 hex): those paired
 * here first, then your set's. A phone not named hears it was removed (dial.ts), so a computer
 * names the phones of your set too.
 */
export function namedPhones(here: readonly DeviceCert[], set: readonly DeviceCert[]): string[] {
  const named = [...here, ...set.filter((c) => roleOf(c) === 'phone')].map((c) => c.link.slice(0, 16));
  return [...new Set(named)].slice(0, NAMED_MAX);
}

/** Your computers as a phone dials them, from the app's machines.json (only those still in your set), each with its Runs on line. */
export function phoneComputers(
  records: readonly MachineRecord[],
  opts: { readonly alwaysOn?: string; readonly look?: (id: string) => { readonly name?: string; readonly icon?: string; readonly kind?: string; readonly distro?: string } | undefined; readonly words?: (id: string) => { readonly line: string; readonly why?: string } | undefined } = {},
): PhoneComputer[] {
  return records
    .filter((r) => roleOf(r.cert) === 'computer')
    .slice(0, MAX_PHONE_COMPUTERS)
    .map((r) => {
      const id = deviceId(r.cert);
      const look = opts.look?.(id);
      const icon = look?.icon ?? r.icon;
      return {
        id,
        name: (look?.name ?? r.name).slice(0, 64),
        ...(icon ? { icon } : {}),
        ...(look?.kind ? { kind: look.kind } : {}),
        ...(look?.distro ? { distro: look.distro } : {}),
        platform: r.cert.platform,
        address: r.address,
        relays: r.relays.slice(0, 4),
        ...(r.lastSeen !== undefined ? { lastSeen: r.lastSeen } : {}),
        ...(opts.alwaysOn === id ? { alwaysOn: true } : {}),
        ...runsOn(opts.words?.(id)),
      };
    });
}

const runsOn = (w: { readonly line: string; readonly why?: string } | undefined): Pick<PhoneComputer, 'line' | 'why'> => (w ? { line: w.line.slice(0, 200), ...(w.why ? { why: w.why.slice(0, 200) } : {}) } : {});

/**
 * A computer's Runs on line and why it can't take `runtime`'s work, as the Mac's menu says them.
 * Only what it said about itself (its version, its runtimes): whether it answers is the phone's to
 * say from its own link, since the Mac's word goes stale while it sleeps.
 */
export function runsOnWords(m: MachineView, runtime: string, now = Date.now()): { line: string; why?: string } {
  const why = m.info ? whyNot({ ...m, status: 'online' }, runtime, now) : undefined;
  return { line: statusLine(m), ...(why ? { why } : {}) };
}

/**
 * What a list says apart from when each was last seen: a phone hears the list again only when this
 * changes (machines.json's lastSeen moves on every poll), and with the welcome of every link.
 */
export function computersKey(list: readonly PhoneComputer[]): string {
  return JSON.stringify(list.map(({ lastSeen: _seen, ...rest }) => rest));
}
