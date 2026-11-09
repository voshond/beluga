import { randomUUID } from 'node:crypto';
import type { ClientKind } from '../ipc/client.js';
import type { Cap, DaemonFrame } from '../ipc/protocol.js';

/** One screen attached to the daemon. */
export interface ConnectedClient {
  readonly id: string;
  readonly kind: ClientKind;
  readonly version: string;
  readonly launchDir?: string;
  readonly caps: readonly Cap[];
  readonly send: (frame: DaemonFrame) => void;
  /** When it last asked for something (capabilities without a caller go to the most recent). */
  lastActive: number;
}

/** The screens attached right now. */
export class ClientRegistry {
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly changeListeners = new Set<(count: number) => void>();

  add(info: Omit<ConnectedClient, 'id' | 'lastActive'>): ConnectedClient {
    // Your app driving this computer is `machine:<id>`, so what it causes knows (client-context.ts fromMachine).
    const client: ConnectedClient = { ...info, id: info.kind === 'machine' ? `machine:${randomUUID()}` : randomUUID(), lastActive: Date.now() };
    this.clients.set(client.id, client);
    this.changed();
    return client;
  }

  remove(id: string): void {
    if (this.clients.delete(id)) this.changed();
  }

  get(id: string | undefined): ConnectedClient | undefined {
    return id ? this.clients.get(id) : undefined;
  }

  list(): ConnectedClient[] {
    return [...this.clients.values()];
  }

  get size(): number {
    return this.clients.size;
  }

  touch(id: string): void {
    const c = this.clients.get(id);
    if (c) c.lastActive = Date.now();
  }

  /** The screen that should do something only a screen can (copy, open a link…): the caller, else the most recent one that can. */
  pick(cap: Cap, caller?: string): ConnectedClient | undefined {
    const own = this.get(caller);
    if (own?.caps.includes(cap)) return own;
    return this.list()
      .filter((c) => c.caps.includes(cap))
      .sort((a, b) => b.lastActive - a.lastActive)[0];
  }

  /**
   * Who shows desktop notifications: the Mac app if it's attached (native ones), else your app
   * driving this computer (BLG-776: a computer's news reaches you where you are), else the most
   * recent screen.
   */
  pickNotifier(): ConnectedClient | undefined {
    const able = this.list().filter((c) => c.caps.includes('notify'));
    const recent = (kind: ConnectedClient['kind']): ConnectedClient | undefined => able.filter((c) => c.kind === kind).sort((a, b) => b.lastActive - a.lastActive)[0];
    return recent('mac') ?? recent('machine') ?? able.sort((a, b) => b.lastActive - a.lastActive)[0];
  }

  /** Send to one screen, or every screen. */
  send(frame: DaemonFrame, to?: string): void {
    if (to !== undefined) return void this.deliver(this.clients.get(to), frame);
    for (const c of this.clients.values()) this.deliver(c, frame);
  }

  /** One screen failing (a socket closing mid-send) mustn't stop the others getting it. */
  private deliver(client: ConnectedClient | undefined, frame: DaemonFrame): void {
    try {
      client?.send(frame);
    } catch {
      // that screen is going away; its close handler cleans up
    }
  }

  onChange(listener: (count: number) => void): () => void {
    this.changeListeners.add(listener);
    return () => void this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const l of [...this.changeListeners]) l(this.clients.size);
  }
}
