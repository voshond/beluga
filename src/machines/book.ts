import { z } from 'zod';
import { deviceId } from '../companion/devices.js';
import { DeviceCert, RelayUrl } from '../companion/protocol.js';
import { readJson, writeJson } from '../net/mesh/files.js';

/**
 * The computers this app drives (BLG-774), in ~/.beluga/machines.json (0600): each one's
 * certificate, where to dial it (its companion address and relays), what it's called and looks
 * like as last heard, and when it was last seen. Nothing secret: keys are public, the set is signed.
 */

export const MachineRecord = z.object({
  cert: DeviceCert,
  /** Its companion address (hex): where the app dials it. */
  address: z.string().regex(/^[0-9a-f]{64}$/),
  /** Its relay URLs, newest first. */
  relays: z.array(RelayUrl).max(4).default([]),
  /** Its name and icon as it last said (the computer keeps them, BLG-780). */
  name: z.string().min(1).max(64),
  icon: z.string().max(200).optional(),
  version: z.string().max(40).optional(),
  pairedAt: z.number().int().min(0),
  lastSeen: z.number().int().min(0).optional(),
  /** The ssh host it was added over (Add Over SSH, BLG-781): your editor opens its folders over Remote-SSH (BLG-794). */
  ssh: z.string().min(1).max(255).optional(),
});
export type MachineRecord = z.infer<typeof MachineRecord>;

export class MachineBook {
  private list: readonly MachineRecord[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {
    const raw = readJson(file);
    this.list = (Array.isArray(raw) ? raw : []).flatMap((r) => {
      const parsed = MachineRecord.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  all = (): readonly MachineRecord[] => this.list;
  get = (id: string): MachineRecord | undefined => this.list.find((r) => deviceId(r.cert) === id);

  /** Keep a computer; the same one again replaces it. */
  add(record: MachineRecord): MachineRecord {
    this.save([...this.list.filter((r) => r.cert.device !== record.cert.device), record]);
    return record;
  }

  update(id: string, patch: Partial<Pick<MachineRecord, 'name' | 'icon' | 'version' | 'lastSeen' | 'relays' | 'address' | 'ssh'>>): void {
    const current = this.get(id);
    if (current) this.save(this.list.map((r) => (r === current ? { ...r, ...patch } : r)));
  }

  /** Drop the computers whose device key is in `devices` (forgotten). */
  drop(devices: ReadonlySet<string>): void {
    const rest = this.list.filter((r) => !devices.has(r.cert.device));
    if (rest.length !== this.list.length) this.save(rest);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private save(next: readonly MachineRecord[]): void {
    this.list = next;
    writeJson(this.file, next);
    for (const l of [...this.listeners]) l();
  }
}
