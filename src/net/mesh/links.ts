import type DHT from 'hyperdht';
import type { KeyPair, NoiseSocket, Server } from 'hyperdht';
import { type MessageSocket, fromStream } from '../transport.js';
import { CLOSE, MeshLink } from './link.js';
import { type TunnelOptions, Tunnels } from './tunnel.js';
import type { LinkMessage } from './wire.js';

/**
 * Staying connected to everyone you know: your Mac listens at its address, dials each friend
 * and group member who isn't linked yet (backing off while they're away), and accepts only
 * people it knows. If a direct connection can't be made, it tries a tunnel through someone
 * linked to both of you (tunnel.ts). Two Macs that dial each other at once keep the same one
 * of the two connections, decided the same way on both sides.
 */

export interface Timing {
  /** How long a dial (direct or tunnel) may take. */
  readonly dialTimeoutMs: number;
  /** Retry delays while someone can't be reached: doubling from min to max. */
  readonly backoffMinMs: number;
  readonly backoffMaxMs: number;
  /** Heartbeat on each link; three missed and the link is dropped. */
  readonly pingMs: number;
  /** How often groups compare what they have, even with nothing new. */
  readonly syncMs: number;
  /** How long a pairing may take. */
  readonly pairTimeoutMs: number;
}

/** Two connections opened within this long of each other count as a simultaneous dial. */
const SIMULTANEOUS_MS = 3_000;

/**
 * How long a link that lost to another one still hears the other side out before it closes: they may
 * send on it until they see which one is kept, and what they sent then isn't lost (BLG-728).
 */
export const RETIRE_MS = SIMULTANEOUS_MS;

export const DEFAULT_TIMING: Timing = { dialTimeoutMs: 15_000, backoffMinMs: 1_000, backoffMaxMs: 60_000, pingMs: 10_000, syncMs: 30_000, pairTimeoutMs: 20_000 };

/** Who your Mac knows on the network (friends, people in your groups, groups you're joining). */
export interface Contacts {
  byAddress(address: string): string | undefined;
  addressOf(peerId: string): string | undefined;
  /** Everyone to stay linked with (dialed until reached). */
  wanted(): readonly string[];
  /** Someone may link with you (everyone wanted, plus people who may only call in). */
  allows(peerId: string): boolean;
}

export interface LinkManagerOptions {
  readonly node: DHT;
  readonly NoiseStream: TunnelOptions['NoiseStream'];
  readonly keyPair: KeyPair;
  readonly contacts: Contacts;
  readonly timing: Timing;
  readonly maxBytes: number;
  /** Relay tunnels for others, and try tunnels when direct dials fail. */
  readonly relay: boolean;
  /** Tests: pretend there's no direct route to these people. */
  readonly blocked?: (peerId: string) => boolean;
  /** People to ask for a tunnel to someone, best first. */
  readonly relaysFor?: (peerId: string) => readonly string[];
  readonly onLink: (link: MeshLink) => void;
  readonly onUnlink: (peerId: string) => void;
  readonly onMessage: (link: MeshLink, msg: LinkMessage) => void;
  /** Are you pulling a chat file from this person now (see MeshLink)? */
  readonly wantsFiles?: (peerId: string) => boolean;
}

interface DialState {
  attempt: number;
  dialing: boolean;
  timer?: NodeJS.Timeout;
  /** When to try upgrading a relayed link to a direct one next. */
  upgradeAt?: number;
}

export class LinkManager {
  private readonly links = new Map<string, MeshLink>();
  private readonly dials = new Map<string, DialState>();
  /** Links that lost to another one to the same person, each until it closes (see RETIRE_MS). */
  private readonly retiring = new Map<MeshLink, NodeJS.Timeout>();
  private readonly tunnels: Tunnels;
  private server: Server | undefined;
  private closed = false;
  private readonly myAddress: string;

  constructor(private readonly opts: LinkManagerOptions) {
    this.myAddress = opts.keyPair.publicKey.toString('hex');
    this.tunnels = new Tunnels({
      NoiseStream: opts.NoiseStream,
      keyPair: opts.keyPair,
      relay: opts.relay,
      maxBytes: opts.maxBytes,
      timeoutMs: opts.timing.dialTimeoutMs,
      linkOf: (peerId) => this.get(peerId),
      addressOf: (peerId) => opts.contacts.addressOf(peerId),
      adopt: (socket, peerId, outgoing) => this.adopt(socket, peerId, outgoing, 'relay'),
    });
  }

  /** Listen at your address (only people you know get through). */
  async listen(): Promise<void> {
    const { node, contacts, blocked } = this.opts;
    this.server = node.createServer(
      {
        firewall: (remote: Buffer) => {
          const peer = contacts.byAddress(remote.toString('hex'));
          return !peer || blocked?.(peer) === true;
        },
      },
      (stream: NoiseSocket) => this.incoming(stream),
    );
    await this.server.listen(this.opts.keyPair);
  }

  get(peerId: string): MeshLink | undefined {
    const link = this.links.get(peerId);
    return link?.isOpen ? link : undefined;
  }

  linked(): MeshLink[] {
    return [...this.links.values()].filter((l) => l.isOpen);
  }

  /** Dial everyone wanted who isn't linked; drop links to people no longer known. */
  refresh(): void {
    if (this.closed) return;
    const wanted = new Set(this.opts.contacts.wanted());
    for (const [peerId, link] of this.links) if (!this.opts.contacts.allows(peerId)) link.close(CLOSE.notAllowed, 'not known');
    for (const link of this.retiring.keys()) if (!this.opts.contacts.allows(link.peerId)) link.close(CLOSE.notAllowed, 'not known');
    for (const [peerId, st] of this.dials) {
      if (wanted.has(peerId)) continue;
      clearTimeout(st.timer);
      this.dials.delete(peerId);
    }
    for (const peerId of wanted) {
      const st = this.state(peerId);
      const link = this.get(peerId);
      if (!link && !st.dialing && !st.timer) void this.dial(peerId);
      // Relayed: now and then, see whether a direct route works now (a direct link replaces it).
      else if (link?.via === 'relay' && !st.dialing && !this.opts.blocked?.(peerId) && Date.now() >= (st.upgradeAt ?? 0)) {
        st.upgradeAt = Date.now() + this.opts.timing.backoffMaxMs;
        void this.dialDirect(peerId).catch(() => false);
      }
    }
  }

  /** Try someone again now (e.g. they just sent a message our way). */
  poke(peerId: string): void {
    const st = this.state(peerId);
    clearTimeout(st.timer);
    st.timer = undefined;
    st.attempt = 0;
    if (!this.get(peerId) && !st.dialing) void this.dial(peerId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const st of this.dials.values()) clearTimeout(st.timer);
    this.tunnels.close();
    for (const link of this.links.values()) link.close(CLOSE.quiet, 'bye');
    for (const [link, timer] of this.retiring) {
      clearTimeout(timer);
      link.close(CLOSE.quiet, 'bye');
    }
    this.retiring.clear();
    await this.server?.close().catch(() => undefined);
  }

  private state(peerId: string): DialState {
    let st = this.dials.get(peerId);
    if (!st) {
      st = { attempt: 0, dialing: false };
      this.dials.set(peerId, st);
    }
    return st;
  }

  private async dial(peerId: string): Promise<void> {
    const st = this.state(peerId);
    st.dialing = true;
    let ok = false;
    try {
      const direct = !this.opts.blocked?.(peerId) && (await this.dialDirect(peerId));
      ok = direct || (this.opts.relay && !this.closed && !this.get(peerId) && (await this.tunnels.open(peerId, this.relayCandidates(peerId))));
    } catch {
      ok = false;
    } finally {
      st.dialing = false;
    }
    if (this.closed || !this.opts.contacts.wanted().includes(peerId)) return;
    if (ok || this.get(peerId)) {
      st.attempt = 0;
      return;
    }
    const { backoffMinMs, backoffMaxMs } = this.opts.timing;
    const delay = Math.min(backoffMaxMs, backoffMinMs * 2 ** st.attempt) * (0.75 + Math.random() / 2);
    st.attempt += 1;
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (!this.get(peerId) && !st.dialing) void this.dial(peerId);
    }, delay);
    st.timer.unref();
  }

  private relayCandidates(peerId: string): string[] {
    const preferred = this.opts.relaysFor?.(peerId) ?? [];
    const rest = this.linked()
      .map((l) => l.peerId)
      .filter((p) => !preferred.includes(p));
    return [...preferred.filter((p) => this.get(p)), ...rest].filter((p) => p !== peerId && this.get(p)?.via === 'direct');
  }

  private dialDirect(peerId: string): Promise<boolean> {
    const address = this.opts.contacts.addressOf(peerId);
    if (!address || this.closed) return Promise.resolve(false);
    let stream: NoiseSocket;
    try {
      stream = this.opts.node.connect(Buffer.from(address, 'hex'));
    } catch {
      return Promise.resolve(false);
    }
    const socket = fromStream(stream, { maxBytes: this.opts.maxBytes });
    return new Promise((resolve) => {
      const timer = setTimeout(() => socket.terminate(), this.opts.timing.dialTimeoutMs);
      timer.unref();
      socket.once('open', () => {
        clearTimeout(timer);
        const ok = stream.remotePublicKey?.toString('hex') === address && this.adopt(socket, peerId, true, 'direct');
        if (!ok) socket.terminate();
        resolve(ok);
      });
      socket.once('close', () => {
        clearTimeout(timer);
        resolve(false);
      });
      socket.on('error', () => undefined);
    });
  }

  private incoming(stream: NoiseSocket): void {
    const socket = fromStream(stream, { maxBytes: this.opts.maxBytes, open: true });
    socket.on('error', () => undefined);
    const peerId = this.opts.contacts.byAddress(stream.remotePublicKey.toString('hex'));
    if (!peerId || this.closed || !this.adopt(socket, peerId, false, 'direct')) socket.terminate();
  }

  /** Which of two links to the same person both sides keep: direct over relayed, a reconnection over a stale link, then the one dialed by the lower address. */
  private preferred(a: MeshLink, b: MeshLink): MeshLink {
    if (a.via !== b.via) return a.via === 'direct' ? a : b;
    // Not a simultaneous dial: the other side came back (restarted, or its old link died), so the
    // newer one wins on both sides instead of the stale one blocking it until its heartbeat fails.
    if (Math.abs(a.openedAt - b.openedAt) > SIMULTANEOUS_MS) return a.openedAt > b.openedAt ? a : b;
    const dialer = (l: MeshLink): string => (l.outgoing ? this.myAddress : (this.opts.contacts.addressOf(l.peerId) ?? ''));
    if (dialer(a) !== dialer(b)) return dialer(a) < dialer(b) ? a : b;
    return a.openedAt >= b.openedAt ? a : b;
  }

  private adopt(socket: MessageSocket, peerId: string, outgoing: boolean, via: 'direct' | 'relay'): boolean {
    if (this.closed || !this.opts.contacts.allows(peerId)) return false;
    const wants = this.opts.wantsFiles;
    const link = new MeshLink(peerId, socket, outgoing, via, this.opts.timing.pingMs, wants ? () => wants(peerId) : undefined);
    link.on('message', (msg) => {
      if (this.links.get(peerId) !== link && !this.retiring.has(link)) return;
      try {
        if (!this.tunnels.handle(link, msg)) this.opts.onMessage(link, msg);
      } catch {
        // Whatever one message does wrong stays with that message.
      }
    });
    link.on('close', () => this.lost(peerId, link));
    const existing = this.get(peerId);
    if (existing && this.preferred(link, existing) === existing) {
      this.retire(link);
      return true;
    }
    this.links.set(peerId, link);
    if (existing) this.retire(existing);
    const st = this.state(peerId);
    clearTimeout(st.timer);
    st.timer = undefined;
    st.attempt = 0;
    this.opts.onLink(link);
    return true;
  }

  /** Nothing more goes out on it; what comes in is still heard until it closes. */
  private retire(link: MeshLink): void {
    const timer = setTimeout(() => {
      this.retiring.delete(link);
      link.close(CLOSE.duplicate, 'duplicate');
    }, RETIRE_MS);
    timer.unref();
    this.retiring.set(link, timer);
  }

  private lost(peerId: string, link: MeshLink): void {
    clearTimeout(this.retiring.get(link));
    this.retiring.delete(link);
    if (this.links.get(peerId) !== link) return;
    // The other side kept the one this side was retiring (each side decides by its own clock): go on with that.
    const spare = this.closed ? undefined : [...this.retiring.keys()].find((l) => l.peerId === peerId && l.isOpen);
    if (spare) {
      clearTimeout(this.retiring.get(spare));
      this.retiring.delete(spare);
      this.links.set(peerId, spare);
      this.opts.onLink(spare);
      return;
    }
    this.links.delete(peerId);
    this.tunnels.dropPeer(peerId);
    this.opts.onUnlink(peerId);
    if (this.closed) return;
    // Come back soon: the other side may just have restarted.
    const st = this.state(peerId);
    if (!st.timer && !st.dialing) {
      st.timer = setTimeout(() => {
        st.timer = undefined;
        if (!this.get(peerId) && !st.dialing) void this.dial(peerId);
      }, this.opts.timing.backoffMinMs);
      st.timer.unref();
    }
  }
}
