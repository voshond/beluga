import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  CAP_OF,
  DEVICE_APPROVAL_GRACE_SEC,
  DEVICE_OUTPUT_CAP_BYTES,
  DEVICE_TIMEOUT_DEFAULT_SEC,
  DEVICE_TIMEOUT_MAX_SEC,
  type DeviceAsk,
  type DeviceAskMeta,
  type DeviceInfo,
  type DeviceOffer,
  type DeviceRequestFrame,
  type DeviceResult,
} from '../../shared/devices.js';

/**
 * The client devices attached right now (remote apps offering their machine) and the requests
 * waiting on them. A request ends with the device's answer, when its screen drops, or after its
 * timeout plus the time to approve it.
 */

export type DevicesOptions = {
  readonly send: (clientId: string, frame: DeviceRequestFrame) => void;
  /** Where devices upload files and screenshots (a path outside it is refused). */
  readonly uploadsRoot?: string;
  readonly graceSec?: number;
  readonly now?: () => number;
};

type Pending = {
  readonly clientId: string;
  readonly kind: DeviceAsk['kind'];
  readonly resolve: (result: DeviceResult) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
};

const VERB: Readonly<Record<DeviceAsk['kind'], string>> = { run: 'run commands', file: 'send files', screenshot: 'take screenshots' };

const clampTimeout = (sec: number | undefined): number => Math.min(DEVICE_TIMEOUT_MAX_SEC, Math.max(1, Math.round(sec ?? DEVICE_TIMEOUT_DEFAULT_SEC)));

const capOutput = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text) <= DEVICE_OUTPUT_CAP_BYTES) return text;
  return `${Buffer.from(text).subarray(0, DEVICE_OUTPUT_CAP_BYTES).toString()}\n… (cut at 64 KB)`;
};

const inside = (root: string, file: string): boolean => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export class Devices {
  private readonly screens = new Map<string, DeviceInfo>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: DevicesOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A screen offers its machine; one without any device caps is never a device. */
  offer(clientId: string, offer: DeviceOffer): void {
    if (!offer.caps.length) return;
    this.screens.set(clientId, { id: clientId, name: offer.name, os: offer.os, caps: [...new Set(offer.caps)], lastSeen: this.now() });
  }

  seen(clientId: string): void {
    const device = this.screens.get(clientId);
    if (device) this.screens.set(clientId, { ...device, lastSeen: this.now() });
  }

  /** Its screen closed: what was waiting on it fails at once. */
  gone(clientId: string): void {
    this.screens.delete(clientId);
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId) continue;
      this.finish(id)?.reject(new Error('device disconnected'));
    }
  }

  list(): DeviceInfo[] {
    return [...this.screens.values()].sort((a, b) => a.name.localeCompare(b.name) || b.lastSeen - a.lastSeen);
  }

  /** The device by name (any case); with two of one name, the one seen last. */
  find(name: string): DeviceInfo | undefined {
    const wanted = name.trim().toLowerCase();
    return [...this.screens.values()].filter((d) => d.name.toLowerCase() === wanted).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  }

  request(name: string, ask: DeviceAsk, meta: DeviceAskMeta): Promise<DeviceResult> {
    const all = this.list();
    if (!all.length) return Promise.reject(new Error('No client device is connected'));
    const device = this.find(name);
    if (!device) return Promise.reject(new Error(`No device called "${name}" (connected: ${all.map((d) => d.name).join(', ')})`));
    if (!device.caps.includes(CAP_OF[ask.kind])) return Promise.reject(new Error(`${device.name} doesn't let agents ${VERB[ask.kind]}`));
    const id = randomUUID();
    const timeoutSec = clampTimeout(meta.timeoutSec);
    const waitMs = (timeoutSec + (this.opts.graceSec ?? DEVICE_APPROVAL_GRACE_SEC)) * 1000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id)?.reject(new Error(`${device.name} didn't answer within ${Math.round(waitMs / 1000)}s`)), waitMs);
      timer.unref?.();
      this.pending.set(id, { clientId: device.id, kind: ask.kind, resolve, reject, timer });
      const frame: DeviceRequestFrame = {
        ...ask,
        t: 'device_request',
        id,
        timeoutSec,
        why: meta.why,
        ...(meta.conversation ? { conversation: meta.conversation } : {}),
        ...(meta.agent ? { agent: meta.agent } : {}),
      };
      try {
        this.opts.send(device.id, frame);
      } catch (err) {
        this.finish(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** A device's answer; only the screen that was asked can settle it. */
  settle(clientId: string, id: string, result: DeviceResult): boolean {
    const p = this.pending.get(id);
    if (!p || p.clientId !== clientId) return false;
    this.finish(id);
    p.resolve(this.checked(p.kind, result));
    return true;
  }

  close(reason = 'Closed'): void {
    for (const id of [...this.pending.keys()]) this.finish(id)?.reject(new Error(reason));
    this.screens.clear();
  }

  private finish(id: string): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }

  private checked(kind: DeviceAsk['kind'], result: DeviceResult): DeviceResult {
    const stdout = capOutput(result.stdout);
    const stderr = capOutput(result.stderr);
    const capped: DeviceResult = { ...result, ...(stdout !== undefined ? { stdout } : {}), ...(stderr !== undefined ? { stderr } : {}) };
    if (result.outcome !== 'ok' || kind === 'run') return capped;
    if (!result.path) return { outcome: 'error', error: 'The device sent no file' };
    const root = this.opts.uploadsRoot;
    if (root && !inside(root, result.path)) return { outcome: 'error', error: 'The device sent a file outside the uploads folder' };
    return capped;
  }
}

/** Which devices serve a session (the daemon's), so the API and the agents can reach them. */
const attached = new WeakMap<object, Devices>();
export const attachDevices = (session: object, devices: Devices): void => void attached.set(session, devices);
export const devicesOf = (session: object): Devices | undefined => attached.get(session);
