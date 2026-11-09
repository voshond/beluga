import { hkdfSync } from 'node:crypto';
import type DHT from 'hyperdht';
import { z } from 'zod';
import type { Identity } from '../net/crypto.js';

/**
 * Never two of you, never none (BLG-799). Whichever install of yours is you on the network holds a
 * lease: a small record on the DHT, under a key only your identity derives, that it renews every
 * minute ({ holder, name, at }, the DHT's own sequence number orders them). Every install of yours
 * that has your identity can read it, and only those can write it.
 *
 *  - The holder renews it. If it finds a newer lease of another install's (one that stood in while it
 *    was away), it stops being you at once (`standDown`): two at once is refused by the lease.
 *  - This Mac, while your Always On is elsewhere, keeps a standby (always-on.ts). Once the Always On
 *    hasn't answered it for 10 minutes and its lease hasn't been renewed for 10 minutes either (its
 *    address isn't announced), this Mac stands in from the last replica it has, and says so.
 *  - Standing in, it hands back by itself as soon as the Always On answers again, merging what came.
 *  - An install starting up that was your Always On asks the lease first (`mayRun`), so it never comes
 *    back on as a second you while this Mac stands in.
 */

export const TAKEOVER_MS = 10 * 60_000;
export const RENEW_MS = 60_000;
const READ_MS = 8_000;

export const Lease = z.object({ v: z.literal(1), holder: z.string().regex(/^[0-9a-f]{16}$/), name: z.string().min(1).max(64), at: z.number().int().min(0) });
export type Lease = z.infer<typeof Lease> & { readonly seq: number };

/** Where the lease is kept: the DHT, or memory in tests. */
export interface LeaseBoard {
  read(identity: Identity): Promise<Lease | undefined>;
  write(identity: Identity, lease: Omit<Lease, 'seq'>, seq: number): Promise<void>;
}

/** The lease's DHT key pair: HKDF of your identity's seed, 'beluga-lease-v1' (only your identity derives it). */
async function leaseKeyPair(identity: Identity): Promise<{ publicKey: Buffer; secretKey: Buffer }> {
  const DHTClass = (await import('hyperdht')).default;
  const d = identity.privateKey.export({ format: 'jwk' }).d;
  if (!d) throw new Error('Identity key has no private part');
  return DHTClass.keyPair(Buffer.from(hkdfSync('sha256', Buffer.from(d, 'base64url'), Buffer.from('beluga-lease'), Buffer.from('beluga-lease-v1'), 32)));
}

const within = <T>(ms: number, p: Promise<T>): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref?.())]);

/** The lease on the DHT, through the node this install already runs (the companion's). */
export function dhtLeaseBoard(node: () => Promise<DHT>): LeaseBoard {
  return {
    read: async (identity) => {
      const keyPair = await leaseKeyPair(identity);
      const got = await within(READ_MS, (await node()).mutableGet(keyPair.publicKey, { latest: true }).catch(() => null));
      if (!got) return undefined;
      try {
        const parsed = Lease.omit({}).safeParse(JSON.parse(got.value.toString('utf8')));
        return parsed.success ? { ...parsed.data, seq: got.seq } : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (identity, lease, seq) => {
      const keyPair = await leaseKeyPair(identity);
      await (await node()).mutablePut(keyPair, Buffer.from(JSON.stringify(lease)), { seq });
    },
  };
}

/** What the keeper asks of Always On (always-on.ts). */
export interface LeaseHost {
  /** This install has taken part in an Always On (always-on.json): the others never touch the lease. */
  involved(): boolean;
  holding(): boolean;
  standingIn(): { id: string; name: string } | undefined;
  at(): string | undefined;
  leaseIdentity(): Identity | undefined;
  canStandIn(): boolean;
  standIn(): Promise<void>;
  standDown(holder: { id: string; name: string }): Promise<void>;
  handBack(): Promise<void>;
  refreshStandby(): Promise<boolean>;
}

export interface LeaseOptions {
  readonly host: LeaseHost;
  readonly board: LeaseBoard;
  /** This install, as the lease names it. */
  readonly self: () => { id: string; name: string };
  /** When your Always On last answered this install over the link (ms), if it has since it started. */
  readonly heard: (id: string) => number | undefined;
  /** Whether it answers right now (asked when standing in). */
  readonly reachable: (id: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly renewMs?: number;
  readonly takeoverMs?: number;
  /** How often this Mac's replica is refreshed while the Always On answers (10 minutes). */
  readonly replicaMs?: number;
  readonly log?: (line: string) => void;
}

export class LeaseKeeper {
  private timer?: NodeJS.Timeout;
  private readonly startedAt: number;
  private seq = 0;
  private replicaAt = 0;
  private ticking?: Promise<void>;

  constructor(private readonly opts: LeaseOptions) {
    this.startedAt = this.now();
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.renewMs ?? RENEW_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Before this install starts your network: undefined when it may, else why not (another install of
   * yours holds a newer lease, renewed lately). Installs that were never an Always On don't ask.
   */
  async mayRun(): Promise<string | undefined> {
    const { host } = this.opts;
    const identity = host.involved() && host.holding() ? host.leaseIdentity() : undefined;
    if (!identity) return undefined;
    const lease = await this.opts.board.read(identity).catch(() => undefined);
    if (!lease || lease.holder === this.opts.self().id || !this.fresh(lease)) return undefined;
    await host.standDown({ id: lease.holder, name: lease.name });
    return `${lease.name} is you on the network right now: this one waits until it's handed back.`;
  }

  /** One round (every minute): renew, stand down, stand in or hand back, whichever is due. */
  tick(): Promise<void> {
    this.ticking ??= this.round().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async round(): Promise<void> {
    const { host, board } = this.opts;
    const identity = host.involved() ? host.leaseIdentity() : undefined;
    if (!identity) return;
    const lease = await board.read(identity).catch(() => undefined);
    if (lease) this.seq = Math.max(this.seq, lease.seq);
    const self = this.opts.self();
    if (host.holding()) {
      // Someone newer holds it (stood in while this one was away): stop being you.
      if (lease && lease.holder !== self.id && this.fresh(lease)) return void (await host.standDown({ id: lease.holder, name: lease.name }));
      await this.renew(identity, self);
      // Standing in: give it back the moment your Always On answers.
      const standIn = host.standingIn();
      if (standIn && (await this.opts.reachable(standIn.id).catch(() => false))) await host.handBack();
      return;
    }
    const at = host.at();
    if (!at) return;
    const heard = this.opts.heard(at);
    // While it answers: keep the replica fresh, and nothing else.
    if (heard !== undefined && this.now() - heard < this.takeoverMs()) {
      if (this.now() - this.replicaAt >= (this.opts.replicaMs ?? TAKEOVER_MS) && (await host.refreshStandby())) this.replicaAt = this.now();
      return;
    }
    if (!host.canStandIn()) return;
    // Still renewed lately: it's up, wherever it is.
    if (lease && this.fresh(lease)) return;
    // Down for long: not heard for 10 minutes (counting from this install's start), or its lease 10 minutes stale.
    const silent = this.now() - Math.max(heard ?? 0, this.startedAt) >= this.takeoverMs();
    if (!silent && !lease) return;
    // One last try over the link before becoming you.
    if (await this.opts.reachable(at).catch(() => false)) return;
    this.opts.log?.(`lease: your Always On hasn't answered for ${Math.round(this.takeoverMs() / 60_000)} minutes; standing in`);
    await host.standIn();
    await this.renew(identity, self);
  }

  private async renew(identity: Identity, self: { id: string; name: string }): Promise<void> {
    this.seq += 1;
    await this.opts.board.write(identity, { v: 1, holder: self.id, name: self.name.slice(0, 64), at: this.now() }, this.seq).catch((err: unknown) => this.opts.log?.(`lease: couldn't renew: ${err instanceof Error ? err.message : String(err)}`));
  }

  private fresh(lease: Lease): boolean {
    return this.now() - lease.at < this.takeoverMs();
  }

  private takeoverMs(): number {
    return this.opts.takeoverMs ?? TAKEOVER_MS;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
