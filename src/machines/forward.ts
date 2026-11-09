import net from 'node:net';
import type { MessageSocket } from '../net/transport.js';
import type { PortForward, PortShare } from '../shared/forwards.js';

export type { PortForward, PortShare } from '../shared/forwards.js';

/**
 * A computer's dev servers on this Mac (BLG-802), and this Mac's services on a computer (BLG-804):
 * TCP byte streams carried over one end-to-end link per computer, beside the screens' links.
 *
 * The app opens the link with a `tunnels` hello (Machines.accept hands it to serveTunnels on the
 * computer). On it, either side may ask the other to `open` a stream to its own localhost:<port>,
 * and each side decides what it lets be opened: the computer, any port (it's your app, which could
 * run anything there); this Mac, only the ports you shared with that computer. Bytes go as base64
 * in `data` frames, a little at a time: a sender waits for `ack`s once a window is in flight, so a
 * big bundle never floods the link and HMR's websocket keeps its pace. `listen` asks the computer
 * to take connections on its localhost:<port> for this Mac (a shared port).
 *
 * The app's Forwarder asks each computer it drives for its worktrees' ports (machines.ports) every
 * few seconds and listens for each on this Mac: the same port on 127.0.0.1 when it's free, so OAuth
 * callbacks, CORS and HMR keep working, else the next free one, said in the Ports tab.
 */

/** Bytes per data frame before base64, and how much may be in flight before the sender waits. */
const CHUNK = 48 * 1024;
const WINDOW = 1024 * 1024;
/** Streams open at once on one link. */
const MAX_STREAMS = 256;

type Frame =
  | { t: 'tunnels'; v: 1 }
  | { t: 'open'; id: string; port: number }
  | { t: 'opened'; id: string }
  | { t: 'data'; id: string; b64: string }
  | { t: 'ack'; id: string; n: number }
  | { t: 'close'; id: string; error?: string }
  | { t: 'listen'; port: number }
  | { t: 'unlisten'; port: number }
  | { t: 'listening'; port: number; ok: boolean; error?: string };

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 32;

function parse(text: string): Frame | undefined {
  try {
    const f = JSON.parse(text) as Frame;
    if (!f || typeof f !== 'object' || typeof f.t !== 'string') return undefined;
    if ('id' in f && !validId(f.id)) return undefined;
    if ('port' in f && !validPort(f.port)) return undefined;
    return f;
  } catch {
    return undefined;
  }
}

/** The tunnels hello, the link's first frame from the app. */
export const TUNNELS_HELLO = JSON.stringify({ t: 'tunnels', v: 1 } satisfies Frame);
export const isTunnelsHello = (text: string): boolean => parse(text)?.t === 'tunnels';

interface Stream {
  readonly sock: net.Socket;
  /** The port it reaches (on whichever side). */
  readonly port: number;
  /** Bytes sent and not yet acked. */
  inflight: number;
}

export interface MuxOptions {
  /** Which side this is: its stream ids start with it, so the two never pick the same. */
  readonly side: 'a' | 'c';
  /** May the other side open a stream to this side's localhost:<port>? */
  readonly mayOpen: (port: number) => boolean;
  /** Connect to localhost:<port> here (tests point it elsewhere). */
  readonly connect?: (port: number) => net.Socket;
  /** The other side asked this one to listen (only the computer's side answers it). */
  readonly onListen?: (port: number, on: boolean) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** Streams over one link, both ways (see the top of this file). */
export class TunnelMux {
  private readonly streams = new Map<string, Stream>();
  private seq = 0;
  private readonly listenWaits = new Map<number, (ok: boolean, error?: string) => void>();
  closed = false;

  constructor(
    private readonly link: MessageSocket,
    private readonly opts: MuxOptions,
  ) {
    link.on('message', (text) => this.onFrame(text));
    link.once('close', () => this.shut('The link closed'));
  }

  /** Carry a socket accepted here to the other side's localhost:<port>. */
  carry(sock: net.Socket, port: number): void {
    if (this.closed || this.streams.size >= MAX_STREAMS) return void sock.destroy();
    const id = `${this.opts.side}${++this.seq}`;
    this.attach(id, sock, port);
    this.send({ t: 'open', id, port });
  }

  /** Ask the other side to listen on its localhost:<port> (or stop). */
  listen(port: number, on: boolean): Promise<void> {
    if (!on) {
      this.send({ t: 'unlisten', port });
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.listenWaits.set(port, (ok, error) => (ok ? resolve() : reject(new Error(error ?? `Port ${port} couldn’t be opened there`))));
      this.send({ t: 'listen', port });
    });
  }

  /** End every stream to or from a port at once (it's no longer shared). */
  closePort(port: number): void {
    for (const s of [...this.streams.values()]) if (s.port === port) s.sock.destroy();
  }

  close(): void {
    this.shut('Closed');
    this.link.close(1000);
  }

  get size(): number {
    return this.streams.size;
  }

  private send(frame: Frame): void {
    if (this.link.isOpen) this.link.send(JSON.stringify(frame));
  }

  private attach(id: string, sock: net.Socket, port: number): void {
    const stream: Stream = { sock, port, inflight: 0 };
    this.streams.set(id, stream);
    sock.setNoDelay(true);
    sock.on('data', (buf: Buffer) => {
      for (let at = 0; at < buf.length; at += CHUNK) {
        const piece = buf.subarray(at, at + CHUNK);
        stream.inflight += piece.length;
        this.send({ t: 'data', id, b64: piece.toString('base64') });
      }
      if (stream.inflight > WINDOW) sock.pause();
    });
    sock.on('error', () => undefined);
    sock.once('close', () => {
      if (this.streams.get(id) !== stream) return;
      this.streams.delete(id);
      this.send({ t: 'close', id });
    });
  }

  private onFrame(text: string): void {
    const f = parse(text);
    if (!f) return;
    switch (f.t) {
      case 'open': {
        // The other side's ids start with its letter: never one of ours, never one open.
        if (f.id.startsWith(this.opts.side) || this.streams.has(f.id) || this.streams.size >= MAX_STREAMS || !this.opts.mayOpen(f.port)) return this.send({ t: 'close', id: f.id, error: `Port ${f.port} isn’t shared` });
        const sock = (this.opts.connect ?? connectLocal)(f.port);
        this.attach(f.id, sock, f.port);
        sock.once('connect', () => this.send({ t: 'opened', id: f.id }));
        return;
      }
      case 'data': {
        const s = this.streams.get(f.id);
        if (!s) return;
        const bytes = Buffer.from(f.b64, 'base64');
        s.sock.write(bytes, () => this.send({ t: 'ack', id: f.id, n: bytes.length }));
        return;
      }
      case 'ack': {
        const s = this.streams.get(f.id);
        if (!s) return;
        s.inflight = Math.max(0, s.inflight - f.n);
        if (s.inflight <= WINDOW / 2 && s.sock.isPaused()) s.sock.resume();
        return;
      }
      case 'close': {
        const s = this.streams.get(f.id);
        if (!s) return;
        this.streams.delete(f.id);
        s.sock.end();
        return;
      }
      case 'listen':
      case 'unlisten': {
        const on = f.t === 'listen';
        const port = f.port;
        if (!this.opts.onListen) return on ? this.send({ t: 'listening', port, ok: false, error: 'Not here' }) : undefined;
        void this.opts.onListen(port, on).then(
          () => on && this.send({ t: 'listening', port, ok: true }),
          (err: unknown) => on && this.send({ t: 'listening', port, ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        return;
      }
      case 'listening': {
        const wait = this.listenWaits.get(f.port);
        this.listenWaits.delete(f.port);
        wait?.(f.ok, f.error);
        return;
      }
      default:
        return;
    }
  }

  private shut(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) s.sock.destroy();
    this.streams.clear();
    for (const wait of this.listenWaits.values()) wait(false, why);
    this.listenWaits.clear();
  }
}

/** localhost:<port> here, IPv4 or IPv6, whichever answers (a dev server may take only ::1). */
const connectLocal = (port: number): net.Socket => net.connect({ host: 'localhost', port, autoSelectFamily: true });

/** How long a connect probe waits for an answer (a server on this computer answers at once). */
const PROBE_MS = 300;

/** Something answers on host:port here (a connect that isn't refused; no answer in time counts as yes). */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (yes: boolean): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(yes);
    };
    const timer = setTimeout(() => done(true), PROBE_MS);
    sock.once('connect', () => done(true));
    // Refused, or no such address here (no IPv6): nothing there.
    sock.once('error', () => done(false));
  });
}

/** A wildcard address can't be bound on this port: something holds it (no IPv6 here: nothing to hold). */
function heldOnAll(host: '0.0.0.0' | '::', port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    probe.listen({ host, port, exclusive: true, ...(host === '::' ? { ipv6Only: false } : {}) }, () => probe.close(() => resolve(false)));
  });
}

/**
 * Port `port` is in use here, on any address. Binding 127.0.0.1 and ::1 alone isn't proof: on
 * macOS a specific address binds over a server on :: or 0.0.0.0 (Next.js, vite --host, rails -b
 * 0.0.0.0, Docker's published ports), and localhost would then reach the forward instead of it.
 */
export async function portInUse(port: number): Promise<boolean> {
  const checks = await Promise.all([answers('127.0.0.1', port), answers('::1', port)]);
  if (checks.some(Boolean)) return true;
  return (await heldOnAll('0.0.0.0', port)) || (await heldOnAll('::', port));
}

const inUse = (port: number): NodeJS.ErrnoException => Object.assign(new Error(`Port ${port} is already in use`), { code: 'EADDRINUSE' });

/** Listen on 127.0.0.1:<port> (and ::1 when there's IPv6), as one server, never over one here. → it, or why not. */
async function listenOn(port: number, onConn: (sock: net.Socket) => void): Promise<{ close: () => Promise<void>; port: number }> {
  if (port !== 0 && (await portInUse(port))) throw inUse(port);
  const one = (host: string, p: number): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer(onConn);
      server.once('error', reject);
      server.listen({ host, port: p, exclusive: true }, () => {
        server.off('error', reject);
        server.on('error', () => undefined);
        resolve(server);
      });
    });
  return one('127.0.0.1', port).then(async (v4) => {
    const bound = (v4.address() as net.AddressInfo).port;
    // ::1 too, so `localhost` reaches it however it resolves; taken there means taken.
    const v6 = await one('::1', bound).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        v4.close();
        throw err;
      }
      return undefined;
    });
    const closing = (s: net.Server | undefined): Promise<void> => new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
    return { port: bound, close: () => Promise.all([closing(v4), closing(v6)]).then(() => undefined) };
  });
}

/** How far past a taken port to look for a free one before taking any. */
const NEAR = 20;

/**
 * Listen on this Mac for a port: `port` itself when it's free, else the next free one after it
 * (any free one past that). → where it listens, and how to stop.
 */
export async function listenNear(port: number, onConn: (sock: net.Socket) => void): Promise<{ close: () => Promise<void>; port: number }> {
  for (let p = port; p < Math.min(port + NEAR, 65536); p++) {
    try {
      return await listenOn(p, onConn);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
    }
  }
  return listenOn(0, onConn);
}

/**
 * On the computer: an app of yours opened a tunnels link. Any localhost port here may be opened
 * (your app could run anything here anyway); `listen` takes connections on localhost:<port> here
 * and carries them to your app (a port you shared from it, BLG-804), closed with the link.
 */
export function serveTunnels(link: MessageSocket, opts: { readonly connect?: (port: number) => net.Socket; readonly name?: () => string; readonly log?: (line: string) => void } = {}): TunnelMux {
  const listening = new Map<number, Promise<{ close: () => Promise<void> }>>();
  const mux: TunnelMux = new TunnelMux(link, {
    side: 'c',
    mayOpen: () => true,
    ...(opts.connect ? { connect: opts.connect } : {}),
    onListen: async (port, on) => {
      const had = listening.get(port);
      // Already listening: nothing to do (a link that came back says it again).
      if (on && had) return void (await had);
      listening.delete(port);
      // Off: stopped before anything listens there again, and what was connected through it ends now too.
      if (had) await (await had.catch(() => undefined))?.close();
      if (!on) return mux.closePort(port);
      // The same port, so what's set up for it (a database URL in .env) works as it is.
      // A port in use here is never covered: what runs on it keeps it, and your app hears why.
      const server = listenOn(port, (sock) => mux.carry(sock, port)).catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'EADDRINUSE' ? new Error(`${opts.name?.() ?? 'That computer'} already uses port ${port}: stop what runs on it there, or share another port`) : err;
      });
      listening.set(port, server);
      server.catch(() => listening.get(port) === server && listening.delete(port));
      await server;
    },
    ...(opts.log ? { log: opts.log } : {}),
  });
  link.once('close', () => {
    for (const s of listening.values()) void s.then((l) => l.close(), () => undefined);
    listening.clear();
  });
  return mux;
}

export interface MachinePort {
  readonly workspaceId: string;
  readonly port: number;
  readonly name: string;
}

/** A computer's answer to machines.ports: its worktrees now, and their ports. */
export interface MachinePorts {
  readonly worktrees: readonly string[];
  readonly ports: readonly MachinePort[];
}

export interface ForwarderDeps {
  /** The computers a screen of yours drives now (their ports are looked at while it does). */
  readonly live: () => readonly string[];
  readonly machineName: (id: string) => string;
  /** A call on the computer over a screen's link (door.ts). */
  readonly call: (machineId: string, method: string, args: readonly unknown[]) => Promise<unknown>;
  /** A fresh end-to-end link to the computer, for tunnels. */
  readonly openLink: (machineId: string) => Promise<MessageSocket>;
  /** What's forwarded now, for the app's screens. */
  readonly publish: (forwards: readonly PortForward[]) => void;
  /** Ports shared from this Mac, and which worktrees are on which computer (BLG-804). */
  readonly publishShares?: (shares: readonly PortShare[], onComputers: Readonly<Record<string, string>>) => void;
  readonly pollMs?: number;
  /** Connect to this Mac's localhost:<port> for a shared port (tests point it elsewhere). */
  readonly connect?: (port: number) => net.Socket;
  readonly log?: (line: string) => void;
}

interface Forward extends PortForward {
  readonly close: () => Promise<void>;
}

/** The app's side: each computer's worktree ports, listened for on this Mac (see the top of this file). */
export class Forwarder {
  private readonly forwards = new Map<string, Forward>();
  private readonly muxes = new Map<string, Promise<TunnelMux>>();
  /** Ports you shared from this Mac, per computer, and for which of its worktrees (BLG-804). */
  private readonly shared = new Map<string, Map<number, Set<string>>>();
  /** Each computer's worktrees, as it last said. */
  private readonly worktreesOn = new Map<string, Set<string>>();
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;

  constructor(private readonly deps: ForwarderDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? 3_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const f of this.forwards.values()) void f.close();
    this.forwards.clear();
    for (const m of this.muxes.values()) void m.then((mux) => mux.close(), () => undefined);
    this.muxes.clear();
    this.shared.clear();
    this.deps.publish([]);
    this.publishShares();
  }

  /** The ports shared from this Mac now. */
  shares(): PortShare[] {
    return [...this.shared].flatMap(([machineId, ports]) => [...ports].flatMap(([port, wss]) => [...wss].map((workspaceId) => ({ machineId, workspaceId, port })))).sort((a, b) => a.port - b.port);
  }

  /**
   * Share this Mac's localhost:<port> with a worktree on one of your computers: it listens on its
   * own localhost:<port> and what connects there reaches this Mac's. → the shares now.
   */
  async share(workspaceId: string, port: number): Promise<PortShare[]> {
    const machineId = [...this.worktreesOn].find(([, wss]) => wss.has(workspaceId))?.[0];
    if (!machineId) throw new Error('That worktree isn’t on one of your computers that’s connected now');
    // The link first: a new one says every port already shared, and this one isn't yet.
    const mux = await this.mux(machineId);
    const ports = this.shared.get(machineId) ?? new Map<number, Set<string>>();
    this.shared.set(machineId, ports);
    const first = !ports.has(port);
    ports.set(port, (ports.get(port) ?? new Set()).add(workspaceId));
    if (first) {
      try {
        await mux.listen(port, true);
      } catch (err) {
        ports.delete(port);
        this.publishShares();
        throw err;
      }
    }
    this.publishShares();
    return this.shares();
  }

  /** Stop sharing a port with a worktree: closed there at once when no other worktree there shares it. → the shares now. */
  unshare(workspaceId: string, port: number): PortShare[] {
    for (const [machineId, ports] of this.shared) {
      const wss = ports.get(port);
      if (!wss?.delete(workspaceId) || wss.size) continue;
      ports.delete(port);
      const mux = this.muxes.get(machineId);
      void mux?.then(
        (m) => {
          m.closePort(port);
          return m.listen(port, false);
        },
        () => undefined,
      );
    }
    this.publishShares();
    return this.shares();
  }

  private publishShares(): void {
    const on: Record<string, string> = {};
    for (const [machineId, wss] of this.worktreesOn) for (const ws of wss) on[ws] = machineId;
    this.deps.publishShares?.(this.shares(), on);
  }

  list(): PortForward[] {
    return [...this.forwards.values()].map(({ close: _close, ...f }) => f).sort((a, b) => a.port - b.port);
  }

  /** Look at every computer driven now, once: forward what's new, close what's gone. */
  tick(): Promise<void> {
    this.ticking ??= this.look().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  /** The tunnels link to a computer, opened when first needed and again after it drops. */
  mux(machineId: string): Promise<TunnelMux> {
    const had = this.muxes.get(machineId);
    if (had) return had;
    const opening = this.deps.openLink(machineId).then((link) => {
      link.send(TUNNELS_HELLO);
      const mux = new TunnelMux(link, { side: 'a', mayOpen: (port) => this.shared.get(machineId)?.has(port) ?? false, ...(this.deps.connect ? { connect: this.deps.connect } : {}), ...(this.deps.log ? { log: this.deps.log } : {}) });
      link.once('close', () => {
        if (this.muxes.get(machineId) === opening) this.muxes.delete(machineId);
      });
      // A new link after a drop: what was shared listens there again.
      for (const port of this.shared.get(machineId)?.keys() ?? []) void mux.listen(port, true).catch((err: unknown) => this.deps.log?.(`forward: couldn't share ${port} again: ${err instanceof Error ? err.message : String(err)}`));
      return mux;
    });
    opening.catch(() => {
      if (this.muxes.get(machineId) === opening) this.muxes.delete(machineId);
    });
    this.muxes.set(machineId, opening);
    return opening;
  }

  private async look(): Promise<void> {
    const live = new Set(this.deps.live());
    const seen = new Set<string>();
    let worktreesChanged = false;
    for (const machineId of live) {
      let answer: MachinePorts;
      try {
        answer = (await this.deps.call(machineId, 'machines.ports', [])) as MachinePorts;
      } catch {
        // Not answering now: what's forwarded stays until it answers that it's gone.
        for (const [key, f] of this.forwards) if (f.machineId === machineId) seen.add(key);
        continue;
      }
      const worktrees = new Set(answer.worktrees);
      const had = this.worktreesOn.get(machineId);
      if (!had || had.size !== worktrees.size || [...worktrees].some((w) => !had.has(w))) worktreesChanged = true;
      this.worktreesOn.set(machineId, worktrees);
      // A worktree gone from the computer: what was shared with it closes.
      for (const [port, wss] of this.shared.get(machineId) ?? []) for (const ws of [...wss]) if (!worktrees.has(ws)) this.unshare(ws, port);
      // Shared ports keep their link (opened again after a drop).
      if (this.shared.get(machineId)?.size) await this.mux(machineId).catch(() => undefined);
      for (const p of answer.ports) {
        const key = `${machineId}:${p.port}`;
        seen.add(key);
        if (this.forwards.has(key)) continue;
        await this.open(machineId, p).catch((err: unknown) => this.deps.log?.(`forward: couldn't listen for ${p.port}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    let changed = false;
    for (const [key, f] of this.forwards) {
      if (seen.has(key)) continue;
      void f.close();
      this.forwards.delete(key);
      changed = true;
    }
    if (changed) this.deps.publish(this.list());
    if (worktreesChanged) this.publishShares();
  }

  private async open(machineId: string, p: MachinePort): Promise<void> {
    const server = await listenNear(p.port, (sock) => {
      sock.pause();
      this.mux(machineId).then(
        (mux) => {
          mux.carry(sock, p.port);
          sock.resume();
        },
        () => sock.destroy(),
      );
    });
    const forward: Forward = { machineId, machineName: this.deps.machineName(machineId), workspaceId: p.workspaceId, port: p.port, local: server.port, name: p.name, close: server.close };
    this.forwards.set(`${machineId}:${p.port}`, forward);
    this.deps.publish(this.list());
  }
}

/** Which Forwarder serves a session (the app's daemon), so the API reaches it (BLG-804 shares through it). */
const all = new WeakMap<object, Forwarder>();
export const attachForwarder = (session: object, forwarder: Forwarder): void => void all.set(session, forwarder);
export function needForwarder(session: object): Forwarder {
  const it = all.get(session);
  if (!it) throw new Error('Forwarding ports needs the Beluga daemon running.');
  return it;
}
