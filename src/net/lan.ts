import os from 'node:os';

/**
 * This computer on the local network: the address other computers there reach it at, skipping
 * containers', VPNs' and virtual machines' interfaces. BELUGA_LAN_HOST names it instead (a host
 * name people use, `i9arch`).
 */

type Interfaces = ReturnType<typeof os.networkInterfaces>;

const VIRTUAL = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|podman|cni|flannel|cali|tailscale|tun|tap|utun|wg|zt|ham|awdl|llw|anpi|bridge)/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function lanAddress(ifaces: Interfaces = os.networkInterfaces()): string | undefined {
  const found = Object.entries(ifaces).flatMap(([name, list]) => (VIRTUAL.test(name) ? [] : (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)));
  return found.find((a) => PRIVATE.test(a)) ?? found[0];
}

export interface LanHost {
  readonly host: string;
  readonly ip: string;
}

export function lanHost(env: Readonly<Record<string, string | undefined>> = process.env, ifaces?: Interfaces): LanHost | undefined {
  const ip = lanAddress(ifaces);
  if (!ip) return undefined;
  const named = env.BELUGA_LAN_HOST?.trim();
  return { host: named && /^[A-Za-z0-9.-]+$/.test(named) ? named : ip, ip };
}

const serving = new WeakMap<object, () => boolean>();

/** The daemon says whether its web port serves the network now (src/daemon/main.ts). */
export const attachLanServing = (session: object, serves: () => boolean): void => void serving.set(session, serves);

/** This computer on the network while Beluga serves it there, else undefined. */
export const servedLan = (session: object): LanHost | undefined => (serving.get(session)?.() ? lanHost() : undefined);
