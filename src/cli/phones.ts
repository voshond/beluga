import type { DeviceView } from '../companion/protocol.js';
import type { SocketClient } from '../ipc/socket-client.js';
import { type Exit, type Io, ago } from './io.js';

const seen = (d: DeviceView, now: number): string => (d.linked ? 'linked now' : d.lastSeen ? `last seen ${ago(now - d.lastSeen)} ago` : 'not seen yet');

/** `beluga phones`: the paired phones, or how to pair one. */
export function listPhones(devices: readonly DeviceView[], io: Io, now = Date.now()): Exit {
  if (!devices.length) {
    io.out('No phones paired yet. Pair one with `beluga pair`.\n');
    return 0;
  }
  const width = Math.max(...devices.map((d) => d.name.length));
  io.out(`${devices.map((d) => `  ${d.name.padEnd(width)}  ${d.platform === 'ios' ? 'iPhone' : 'Android'}, ${seen(d, now)}, paired ${ago(now - d.pairedAt)} ago  (${d.id})`).join('\n')}\n`);
  io.out('Remove one with `beluga phones remove <name>`.\n');
  return 0;
}

/** The phone a name (any case) or id means; an error in plain words when none or several do. */
export function findPhone(devices: readonly DeviceView[], which: string): DeviceView | string {
  const want = which.trim().toLowerCase();
  const byId = devices.find((d) => d.id === want);
  if (byId) return byId;
  const named = devices.filter((d) => d.name.toLowerCase() === want);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `${named.length} phones are called “${which}”: remove one by its id (${named.map((d) => d.id).join(', ')}).`;
  return devices.length ? `No paired phone is called “${which}”. Paired: ${devices.map((d) => d.name).join(', ')}.` : 'No phones are paired.';
}

/** The paired phones, and removing one (companion.devices.remove). */
export interface PhoneBook {
  devices(): readonly DeviceView[];
  remove(id: string): Promise<unknown>;
}

export const phoneBookOf = (client: SocketClient): PhoneBook => ({
  devices: () => client.store.getDomain().companion.devices,
  remove: (id) => client.call('companion.devices.remove', id),
});

/** `beluga phones remove <name>`: its certificate goes and its link drops at once. */
export async function removePhone(book: PhoneBook, which: string | undefined, io: Io): Promise<Exit> {
  const devices = book.devices();
  if (!which) {
    io.err('Which phone? `beluga phones remove <name>` (`beluga phones` lists them).\n');
    return 2;
  }
  const phone = findPhone(devices, which);
  if (typeof phone === 'string') {
    io.err(`${phone}\n`);
    return 1;
  }
  await book.remove(phone.id);
  io.out(`Removed ${phone.name}: it can't reach this computer any more. Pair it again with \`beluga pair\`.\n`);
  return 0;
}
