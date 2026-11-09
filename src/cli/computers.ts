import type { SocketClient } from '../ipc/socket-client.js';
import type { SetDeviceView } from '../machines/controllers.js';
import type { ComputerOffer } from '../machines/enroll.js';
import type { MachineView } from '../machines/machines.js';
import { type Exit, type Io, ago, errorText } from './io.js';

/** What `beluga computers` needs from the daemon: machines.*. */
export interface ComputersLink {
  list(): Promise<readonly MachineView[]>;
  devices(): Promise<readonly SetDeviceView[]>;
  forget(id: string): Promise<{ forgotten: string }>;
  joinStart(ticket: string): Promise<ComputerOffer>;
  joinApprove(): Promise<MachineView>;
  joinCancel(): Promise<unknown>;
  /** Add Over SSH (BLG-781): Beluga put on and started there when needed, its pairing dialled. */
  sshPair(host: string): Promise<ComputerOffer>;
}

export const computersLinkOf = (client: SocketClient): ComputersLink => ({
  list: () => client.call('machines.list'),
  devices: () => client.call('machines.devices'),
  forget: (id) => client.call('machines.forget', id),
  joinStart: (ticket) => client.call('machines.join.start', ticket),
  joinApprove: () => client.call('machines.join.approve'),
  joinCancel: () => client.call('machines.join.cancel'),
  sshPair: (host) => client.call('machines.ssh.pair', host),
});

/** A computer's state in a few words: online with what it has free, or when it was last seen. */
export function computerLine(c: MachineView, now = Date.now()): string {
  const what = `${PLATFORM[c.platform]}${c.version ? ` · Beluga ${c.version}` : ''}`;
  // Another protocol (BLG-777): listed, read-only, and which side to update.
  if (c.note) return `${what}, ${c.note}`;
  if (c.status !== 'online') return `${what}, ${c.status === 'offline' ? 'offline' : 'not asked yet'}${c.lastSeen ? `, last seen ${ago(now - c.lastSeen)} ago` : ''}`;
  const i = c.info;
  const free = i ? [`load ${Math.round(i.loadPerCore * 100)}%`, `${i.memory.freeGB} GB memory free`, ...(i.disk ? [`${i.disk.freeGB} GB disk free`] : []), `${i.agentsRunning} agent${i.agentsRunning === 1 ? '' : 's'} running`] : [];
  return [`${what}, online${c.rttMs !== undefined ? ` (${c.rttMs} ms)` : ''}`, ...free].join(', ');
}

const ROLE = { app: 'Beluga app', computer: 'computer', phone: 'phone' } as const;
const PLATFORM = { macos: 'Mac', linux: 'Linux', windows: 'Windows', android: 'Android', ios: 'iPhone' } as const;

/**
 * `beluga computers`: the devices that may drive this computer (your apps), the computers this one
 * drives, and the rest of your set. Each with its id, for `beluga computers forget`.
 */
export async function listComputers(link: ComputersLink, io: Io, now = Date.now()): Promise<Exit> {
  const [computers, devices] = await Promise.all([link.list(), link.devices()]);
  const drivers = devices.filter((d) => d.role === 'app' && !d.self);
  const others = devices.filter((d) => d.role !== 'app' && !d.self && !computers.some((c) => c.id === d.id));
  const line = (name: string, what: string, id: string): string => `  ${name}  ${what}  (${id})`;
  const out: string[] = [];
  if (drivers.length) out.push('May drive this computer:', ...drivers.map((d) => line(d.name, `${ROLE[d.role]} on ${PLATFORM[d.platform]}, signed in ${ago(now - d.issuedAt)} ago`, d.id)), '');
  if (computers.length) out.push('Your computers:', ...computers.map((c) => line(c.name, computerLine(c, now), c.id)), '');
  if (others.length) out.push('Your other devices:', ...others.map((d) => line(d.name, `${ROLE[d.role]} on ${PLATFORM[d.platform]}`, d.id)), '');
  if (!out.length) {
    io.out('No devices of yours here yet. On a computer, run `beluga pair --computer` and add it from your Beluga app (or `beluga computers add <link or code>`).\n');
    return 0;
  }
  io.out(`${out.join('\n')}Forget one, everywhere, with \`beluga computers forget <name>\`.\n`);
  return 0;
}

/** A device of the set a name (any case) or id means; an error in plain words when none or several do. */
export function findDevice(devices: readonly SetDeviceView[], which: string): SetDeviceView | string {
  const want = which.trim().toLowerCase();
  const byId = devices.find((d) => d.id === want);
  if (byId) return byId;
  const named = devices.filter((d) => d.name.toLowerCase() === want);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `${named.length} devices are called “${which}”: forget one by its id (${named.map((d) => d.id).join(', ')}).`;
  return devices.length ? `None of your devices is called “${which}”. Yours: ${devices.map((d) => d.name).join(', ')}.` : 'No devices of yours here.';
}

/** `beluga computers forget <name>`: cut off here at once, and on every other device of yours as they hear. */
export async function forgetDevice(link: ComputersLink, which: string | undefined, io: Io): Promise<Exit> {
  if (!which) {
    io.err('Which device? `beluga computers forget <name>` (`beluga computers` lists them).\n');
    return 2;
  }
  const device = findDevice(await link.devices(), which);
  if (typeof device === 'string') {
    io.err(`${device}\n`);
    return 1;
  }
  if (device.self) {
    io.err('That’s this computer: forget it from your app, or from another of your devices.\n');
    return 1;
  }
  try {
    await link.forget(device.id);
  } catch (err) {
    io.err(`Couldn't forget it: ${errorText(err)}\n`);
    return 1;
  }
  io.out(`Forgot ${device.name}: it's cut off here now, and on your other devices as soon as they hear.\n`);
  return 0;
}

export interface AddComputerOptions {
  readonly ask: (question: string) => Promise<string>;
  readonly signal?: AbortSignal;
}

/** `beluga computers add <link or code>`, in the app's terminal: the computer's four pictures, then Add? [y/N]. */
export async function addComputer(link: ComputersLink, ticket: string | undefined, io: Io, opts: AddComputerOptions): Promise<Exit> {
  if (!ticket) {
    io.err('Which computer? Run `beluga pair --computer` on it, then `beluga computers add <link or code>` here.\n');
    return 2;
  }
  io.err('Looking for the computer…\n');
  return confirmAdd(link, () => link.joinStart(ticket), io, opts);
}

/**
 * `beluga connect you@host --pair` (BLG-781): over your ssh, Beluga is installed and started there
 * when it isn't, a pairing opens, and its pictures (checked over SSH too) are shown before Add?.
 */
export async function addOverSsh(link: ComputersLink, host: string, io: Io, opts: AddComputerOptions): Promise<Exit> {
  io.err(`Adding ${host} over SSH (installing and starting Beluga there if it needs it)…\n`);
  return confirmAdd(link, () => link.sshPair(host), io, opts);
}

/** The computer's offer, its four pictures, Add? [y/N], and then it's in. */
async function confirmAdd(link: ComputersLink, start: () => Promise<ComputerOffer>, io: Io, opts: AddComputerOptions): Promise<Exit> {
  let offer: ComputerOffer;
  try {
    offer = await start();
  } catch (err) {
    io.err(`${errorText(err)}\n`);
    return 1;
  }
  io.out(`“${offer.name}” (${PLATFORM[offer.platform]}, Beluga ${offer.version}) wants to join your devices.\n${offer.sshChecked ? 'It printed these same four pictures over SSH' : 'Check it shows these same four pictures'}: ${offer.fingerprint}\n`);
  const aborted = new Promise<null>((resolve) => opts.signal?.addEventListener('abort', () => resolve(null), { once: true }));
  const said = await Promise.race([opts.ask('Add it? [y/N] '), aborted]);
  if (typeof said !== 'string' || !/^y(es)?$/i.test(said.trim())) {
    await link.joinCancel().catch(() => undefined);
    io.err(said === null ? '\nCancelled. Nothing was added.\n' : 'Not added: the computer is told no.\n');
    return said === null ? 130 : 1;
  }
  try {
    const added = await link.joinApprove();
    io.out(`Added ${added.name}. \`beluga computers\` lists your computers.\n`);
    return 0;
  } catch (err) {
    io.err(`Couldn't add it: ${errorText(err)}\n`);
    return 1;
  }
}
