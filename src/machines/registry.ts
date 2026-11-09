import type { Machines } from './machines.js';

/** Which device set serves a session (the daemon's), so the API can reach it (BLG-774). */
const all = new WeakMap<object, Machines>();

export const attachMachines = (session: object, machines: Machines): void => void all.set(session, machines);
export const detachMachines = (session: object): void => void all.delete(session);

/** The session's machines, if they run (the daemon's door asks without failing). */
export const machinesOf = (session: object): Machines | undefined => all.get(session);

/** The daemon's door for screens (daemon/server.ts): where an app driving this computer is adopted. */
export interface ScreenDoor {
  adoptMachine(socket: import('../net/transport.js').MessageSocket, hello: string): void;
}
const doors = new WeakMap<object, ScreenDoor>();
export const attachScreenDoor = (session: object, door: ScreenDoor): void => void doors.set(session, door);
export const screenDoorOf = (session: object): ScreenDoor | undefined => doors.get(session);

export function needMachines(session: object): Machines {
  const machines = all.get(session);
  if (!machines) throw new Error('Your computers need the Beluga daemon running.');
  return machines;
}
