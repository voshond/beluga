import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BootstrapNode } from 'hyperdht';
import type { Identity } from '../net/crypto.js';
import { DEFAULT_MAILBOX_URL, type MailboxOptions } from '../net/mesh/mailbox.js';
import { Mesh } from '../net/mesh/mesh.js';
import { loadSettings } from './settings.js';
import type { Timing } from '../net/mesh/links.js';
import type { Store } from './store.js';
import { belugaEnv } from './beluga-env.js';
import { installedVersion } from './version.js';
import { localMentions } from './team/mentions.js';
import { networkElsewhere } from '../machines/always-on-state.js';
import { belugaHome } from './home.js';
import type { NetworkSummary } from '../net/mesh/views.js';

/**
 * The Beluga network as a core service: starts your Mac's mesh node (src/net/mesh) next to
 * today's rooms, mirrors what it knows into the shared state for screens, and answers the
 * `network.*` API. Off unless turned on (settings `network: true`, or BELUGA_NETWORK=1), and only
 * one Beluga process per computer runs it (a lock file), so it can't disturb rooms.
 */

const OFF = 'The Beluga network is off. Turn it on with "network": true in ~/.beluga/settings.json (or start with BELUGA_NETWORK=1).';

export const networkEnabled = (settings: { readonly network?: boolean }): boolean => belugaEnv('NETWORK') === '1' || (settings.network === true && belugaEnv('NETWORK') !== '0');

export interface NetworkService {
  readonly mesh: Mesh;
  stop(): Promise<void>;
}

export interface NetworkOptions {
  readonly store: Store;
  readonly identity: Identity;
  readonly name: string;
  /** Where the network keeps its files (normally ~/.beluga). */
  readonly dir: string;
  readonly bootstrap?: readonly BootstrapNode[];
  readonly host?: string;
  readonly timing?: Partial<Timing>;
  /** The mailbox (default: settings `mailbox`, BELUGA_MAILBOX, or Beluga's own). */
  readonly mailbox?: MailboxOptions;
}

/** Which mailbox frames go to when a friend isn't online with you (BLG-272); undefined: none. */
export function mailboxOptions(settings: { readonly mailbox?: string; readonly mailboxAfterMin?: number }): MailboxOptions | undefined {
  const env = belugaEnv('MAILBOX');
  const url = env !== undefined && env !== '' ? env : (settings.mailbox ?? DEFAULT_MAILBOX_URL);
  if (!url || url === 'off' || url === '0' || !/^https?:\/\//.test(url)) return undefined;
  return { url, ...(settings.mailboxAfterMin !== undefined ? { afterMs: settings.mailboxAfterMin * 60_000 } : {}) };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Only one process may be your Mac on the network at a time (two would fight over one address). */
const held = new Set<string>();

function lock(dir: string): () => void {
  const file = path.join(dir, 'network.lock');
  if (held.has(file)) throw new Error('This Beluga is already on the network');
  let holder: number | undefined;
  let exists = false;
  try {
    const text = readFileSync(file, 'utf8');
    exists = true;
    holder = Number(text.trim()) || undefined;
  } catch {
    holder = undefined;
  }
  if (holder && holder !== process.pid && isAlive(holder)) throw new Error(`Another Beluga (process ${holder}) is already on the network`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A stale lock (its process is gone) is replaced; two starting at once can't both win ('wx').
  if (exists) rmSync(file, { force: true });
  try {
    writeFileSync(file, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error('Another Beluga is starting on the network');
  }
  held.add(file);
  return () => {
    held.delete(file);
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  };
}

/** Start the network and keep the store's `network` in step with it. */
export async function startNetwork(opts: NetworkOptions): Promise<NetworkService> {
  const unlock = lock(opts.dir);
  let mesh: Mesh;
  try {
    const mailbox = opts.mailbox ?? mailboxOptions(loadSettings());
    mesh = await Mesh.start({ identity: opts.identity, name: opts.name, dir: opts.dir, app: installedVersion(), ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}), ...(opts.host ? { host: opts.host } : {}), ...(opts.timing ? { timing: opts.timing } : {}), ...(mailbox ? { mailbox } : {}) });
  } catch (err) {
    unlock();
    throw err;
  }
  const { store } = opts;
  // Many changes arrive together (a sync batch): one summary per turn of the event loop.
  let queued = false;
  const push = (): void => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      if (!stopped) store.dispatch({ type: 'net_summary', summary: mesh.summary() });
    });
  };
  // A conversation a screen shows is read as messages arrive; a direct one on a screen in front is Seen,
  // unless you turned that off (BLG-798). Only screens count: an Always On on its own has none.
  const readShown = (): void => {
    const { attention, prefs } = store.getState();
    for (const c of attention.shown) if (c.startsWith('dm:') || c.startsWith('group:')) mesh.markRead(c);
    if (prefs.readReceipts !== false && attention.front) for (const c of attention.visible) mesh.markSeen(c);
  };
  let stopped = false;
  mesh.on('change', push);
  // A team task a message names, by this Mac's own key (core/team/mentions.ts).
  const local = <M extends { readonly text: string }>(m: M): M => {
    const text = localMentions(m.text, store.getState().board.issues);
    return text === m.text ? m : { ...m, text };
  };
  mesh.on('message', (message) => {
    store.dispatch({ type: 'net_message', message: local(message) });
    if (store.getState().attention.shown.includes(message.conversation)) readShown();
  });
  mesh.on('unsent', (conversation, id) => store.dispatch({ type: 'net_unsent', conversation, id }));
  mesh.on('cleared', (conversation) => store.dispatch({ type: 'net_cleared', conversation }));
  mesh.on('reacted', (conversation, id, reactions) => store.dispatch({ type: 'net_reacted', conversation, id, reactions }));
  const offAction = store.onAction((action) => {
    if (action.type === 'attention') readShown();
  });
  store.dispatch({ type: 'net_messages', messages: Object.fromEntries(Object.entries(mesh.recent()).map(([c, list]) => [c, list.map((m) => local(m))])) });
  store.dispatch({ type: 'net_summary', summary: mesh.summary() });
  readShown();
  const service: NetworkService = {
    mesh,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      offAction();
      await mesh.close();
      unlock();
      store.dispatch({ type: 'net_off' });
    },
  };
  return service;
}

const services = new WeakMap<object, NetworkService>();

/** Make the network reachable from the API handlers of this session. */
type NetworkWatcher = (service: NetworkService | undefined) => void;
const watchers = new WeakMap<object, Set<NetworkWatcher>>();

export function attachNetwork(session: object, service: NetworkService): void {
  services.set(session, service);
  for (const fn of watchers.get(session) ?? []) fn(service);
}

export function detachNetwork(session: object): void {
  if (!services.delete(session)) return;
  for (const fn of watchers.get(session) ?? []) fn(undefined);
}

/** Quitting: mail what still waits for friends while every outbox is still running (BLG-272). */
export async function leaveNetwork(session: object): Promise<void> {
  await services.get(session)?.mesh.leaving();
}

/** Hear this session's network come up and go down (now, and on every change). The gateway sends tasks over it. */
export function watchNetwork(session: object, fn: NetworkWatcher): () => void {
  const set = watchers.get(session) ?? new Set<NetworkWatcher>();
  watchers.set(session, set);
  set.add(fn);
  fn(services.get(session));
  return () => void set.delete(fn);
}

/** The network of this session, or a clear error when it's off (or runs on your Always On, BLG-796). */
export function networkOf(session: object): Mesh {
  const service = services.get(session);
  if (!service) throw new Error(networkElsewhere(belugaHome()) ?? OFF);
  return service.mesh;
}

/** This session's network as screens see it, while it runs here (your Always On says it to your app, BLG-796). */
export const networkSummaryOf = (session: object): NetworkSummary | undefined => services.get(session)?.mesh.summary();

export const networkStatus = (session: object): { enabled: boolean; peerId?: string; address?: string; alwaysOn?: string } => {
  const mesh = services.get(session)?.mesh;
  if (mesh) return { enabled: true, peerId: mesh.peerId, address: mesh.address };
  const elsewhere = networkElsewhere(belugaHome());
  return elsewhere ? { enabled: false, alwaysOn: elsewhere } : { enabled: false };
};

export interface NetworkHost {
  readonly session: object;
  readonly store: Store;
  readonly identity: Identity;
  readonly name: string;
  /** Where the network keeps its files (normally ~/.beluga). */
  readonly dir: string;
  /** Demo mode: a simulated network (bob and mia) instead of the real one. */
  readonly demo: boolean;
  readonly warn: (text: string) => void;
}

/** A started (or starting) network: whether it came up, and how to stop it. */
interface Launch {
  /** The service once it's up; undefined if it didn't start (the error says why). */
  readonly ready: Promise<NetworkService | undefined>;
  readonly error: () => string | undefined;
  readonly stop: () => Promise<void>;
}

/** Asked before this session's network starts (BLG-799: the lease says whether another install of yours is you now). */
type NetworkGate = () => Promise<string | undefined>;
const gates = new WeakMap<object, NetworkGate>();
export const gateNetwork = (session: object, gate: NetworkGate): void => void gates.set(session, gate);

/** The gate, once whatever registers it in the same start has (the companion starts after the network switch). */
const gated = (session: object): Promise<string | undefined> => new Promise<void>((resolve) => setImmediate(resolve)).then(() => gates.get(session)?.());

function launch(host: NetworkHost): Launch {
  let stopped = false;
  let error: string | undefined;
  const name = host.name.trim().slice(0, 64) || 'Beluga';
  // Your Always On is you on the network: this install never is at the same time (BLG-796).
  const elsewhere = host.demo ? undefined : networkElsewhere(host.dir);
  const allowed = elsewhere || host.demo ? Promise.resolve(elsewhere) : gated(host.session);
  const ready = allowed.then((why) => (why ? Promise.reject(new Error(why)) : host.demo ? import('./network-demo.js').then((m) => m.startDemoNetwork(host.store, name)) : startNetwork({ store: host.store, identity: host.identity, name, dir: host.dir })))
    .then((service) => {
      if (stopped) {
        void service.stop();
        return undefined;
      }
      attachNetwork(host.session, service);
      return service;
    })
    .catch((err: unknown) => {
      error = err instanceof Error ? err.message : String(err);
      if (!elsewhere && networkElsewhere(host.dir) === undefined) host.warn(`The Beluga network didn't start: ${error}`);
      return undefined;
    });
  return {
    ready,
    error: () => error,
    stop: async () => {
      stopped = true;
      const service = await ready;
      if (!service) return;
      // Before anything stops: what friends haven't taken goes to their mailboxes (BLG-272).
      await service.mesh.leaving();
      detachNetwork(host.session);
      await service.stop();
    },
  };
}

/**
 * Bring the network up for a core when it's turned on (in the background: rooms and screens
 * don't wait for it). Returns how to stop it.
 */
export function launchNetwork(host: NetworkHost, settings: { readonly network?: boolean }): () => Promise<void> {
  if (!networkEnabled(settings)) return async () => undefined;
  return launch(host).stop;
}

/** Turning the network on and off while Beluga runs (Settings, the Mac app's "Turn On"). */
export interface NetworkSwitch {
  /** Start or stop it now; starting resolves once it's up (or fails with why it didn't). */
  set(on: boolean): Promise<void>;
  /** The name it starts with next time (your own, arriving with your identity on your Always On, BLG-796). */
  rename(name: string): void;
  stop(): Promise<void>;
}

const switches = new WeakMap<object, NetworkSwitch>();

/** Like launchNetwork, and the network can be turned on and off later (see `network.setEnabled`). */
export function networkSwitch(start: NetworkHost, settings: { readonly network?: boolean }): NetworkSwitch {
  let host = start;
  let current: Launch | undefined = networkEnabled(settings) ? launch(host) : undefined;
  let turning: Promise<void> = Promise.resolve();
  const set = async (on: boolean): Promise<void> => {
    if (on && !current) {
      const started = launch(host);
      current = started;
      if (await started.ready) return;
      if (current === started) current = undefined;
      throw new Error(started.error() ?? "The Beluga network didn't start");
    }
    if (!on && current) {
      const running = current;
      current = undefined;
      await running.stop();
    }
  };
  const sw: NetworkSwitch = {
    // One change at a time: a quick on/off/on settles in order.
    set: (on) => {
      const next = turning.then(() => set(on));
      turning = next.catch(() => undefined);
      return next;
    },
    rename: (name) => {
      host = { ...host, name };
    },
    stop: async () => {
      switches.delete(host.session);
      await turning;
      const running = current;
      current = undefined;
      await running?.stop();
    },
  };
  switches.set(host.session, sw);
  return sw;
}

/** How to turn this session's network on and off, when its core can (only the daemon's). */
export const networkSwitchOf = (session: object): NetworkSwitch | undefined => switches.get(session);
