import type { IncomingMessage } from 'node:http';
import { type Tunnel, openTunnel, waitUntilReachable } from '../../net/tunnel.js';
import { JoinLimiter } from '../web-sessions.js';
import { hostName } from '../web.js';

/**
 * `beluga web --public`: the web port behind a Cloudflare quick tunnel (the cloudflared rooms and
 * the phone relay already use, net/tunnel.ts), for people with neither Tailscale nor SSH. The
 * https://<name>.trycloudflare.com address alone shows only the Ask for a link page; a join link
 * under it lets a browser in. When cloudflared stops (or its name stops answering), a new tunnel
 * is opened and its new address announced. Wrong join links through it are limited harder than
 * on the local port, per visitor (Cloudflare's own word for their address) and in all.
 */

export interface PublicState {
  /** opening: the first tunnel isn't up yet; reopening: it dropped and a new one is on its way. */
  readonly state: 'opening' | 'on' | 'reopening';
  readonly url?: string;
}

export interface PublicReachOptions {
  /** Open a tunnel to this port; `onDied` when it stops. Default: a cloudflared quick tunnel. */
  readonly open?: (port: number, onDied: (reason: string) => void) => Promise<Tunnel>;
  /** Whether a fresh address answers yet (its name takes a while to resolve). */
  readonly reachable?: (url: string) => Promise<boolean>;
  /** How long to wait before the nth try at a new tunnel after one dropped. */
  readonly retryMs?: (attempt: number) => number;
  /** A new address (or none, while it's down): status and Settings show it. */
  readonly onChange?: (state: PublicState | undefined) => void;
  readonly log?: (line: string) => void;
}

/** Wrong join links allowed through the public address: per visitor, and in all, per 10 minutes. */
export const PUBLIC_JOIN_LIMITS = { perAddress: 5, total: 20, windowMs: 10 * 60_000 } as const;

const defaultOpen = async (port: number, onDied: (reason: string) => void): Promise<Tunnel> => {
  const tunnel = await openTunnel('cloudflared', port, { onDied });
  if (!tunnel) throw new Error('cloudflared opened no tunnel');
  return tunnel;
};
const defaultRetry = (attempt: number): number => Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5));

export class PublicReach {
  readonly limiter: JoinLimiter;
  private tunnel?: Tunnel;
  private current?: PublicState;
  private port?: number;
  private stopped = true;
  private retry?: NodeJS.Timeout;
  private attempt = 0;

  constructor(
    private readonly opts: PublicReachOptions = {},
    limiter = new JoinLimiter(PUBLIC_JOIN_LIMITS.perAddress, PUBLIC_JOIN_LIMITS.total, PUBLIC_JOIN_LIMITS.windowMs),
  ) {
    this.limiter = limiter;
  }

  get state(): PublicState | undefined {
    return this.current;
  }

  /** The public host name the web port must answer to, while there is one. */
  get host(): string | undefined {
    return this.current?.url ? new URL(this.current.url).hostname : undefined;
  }

  /** Whether this request came through the public address. */
  carries(req: IncomingMessage): boolean {
    const host = this.host;
    return !!host && hostName(req.headers.host) === host;
  }

  /** Who a request through the tunnel is: Cloudflare's word for the visitor (every one arrives from loopback here). */
  static visitor(req: IncomingMessage): string {
    const cf = req.headers['cf-connecting-ip'];
    return `public:${(Array.isArray(cf) ? cf[0] : cf) ?? req.socket.remoteAddress ?? '?'}`;
  }

  /** Open the tunnel to this port (or keep the one up, when it's the same port); its https address. */
  async start(port: number): Promise<string> {
    if (!this.stopped && this.port === port && this.current?.url && this.current.state === 'on') return this.current.url;
    this.stop();
    this.stopped = false;
    this.port = port;
    this.set({ state: 'opening' });
    try {
      return await this.openOne(port);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /** Close the tunnel; nothing is reachable through it any more. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    tunnel?.close();
    this.attempt = 0;
    if (this.current) this.set(undefined);
  }

  private async openOne(port: number): Promise<string> {
    const open = this.opts.open ?? defaultOpen;
    let tunnel: Tunnel | undefined;
    const died = (reason: string): void => {
      if (this.stopped || this.tunnel !== tunnel) return;
      this.opts.log?.(`web: the public link dropped (${reason}); opening a new one`);
      this.tunnel = undefined;
      this.set({ state: 'reopening' });
      this.again();
    };
    tunnel = await open(port, died);
    if (this.stopped || this.port !== port) {
      tunnel.close();
      throw new Error('The public link was turned off');
    }
    this.tunnel = tunnel;
    const reachable = this.opts.reachable ?? ((url: string) => waitUntilReachable(url));
    if (!(await reachable(tunnel.publicUrl))) {
      tunnel.close();
      this.tunnel = undefined;
      throw new Error(`${tunnel.publicUrl} didn't answer: Cloudflare may be slow right now. Try again in a minute.`);
    }
    if (this.tunnel !== tunnel) throw new Error('The public link was turned off');
    this.attempt = 0;
    this.set({ state: 'on', url: tunnel.publicUrl });
    this.opts.log?.(`web: public link on ${tunnel.publicUrl}`);
    return tunnel.publicUrl;
  }

  /** After a drop: a new tunnel, trying again (more slowly each time) until one is up or it's turned off. */
  private again(): void {
    if (this.stopped || this.retry || this.port === undefined) return;
    const port = this.port;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.stopped) return;
      this.openOne(port).catch((err: unknown) => {
        if (this.stopped) return;
        this.opts.log?.(`web: no new public link yet: ${err instanceof Error ? err.message : String(err)}`);
        this.attempt++;
        this.again();
      });
    }, (this.opts.retryMs ?? defaultRetry)(this.attempt));
    this.retry.unref?.();
  }

  private set(state: PublicState | undefined): void {
    this.current = state;
    this.opts.onChange?.(state);
  }
}

/** What `beluga web --public` says: the address, a join link, and plainly what that lets in. */
export function publicWords(pub: { readonly url: string; readonly link: { readonly url: string; readonly expiresAt: number } }): string {
  return `Beluga is public at ${pub.url}
Open this link in your browser to let it in (once, until ${new Date(pub.link.expiresAt).toLocaleTimeString()}):

  ${pub.link.url}

What this exposes: the whole Beluga UI (your projects, terminals and Claude)
to anyone who has a join link, from anywhere. The address alone shows only a
page that asks for a link, and wrong links are cut off after ${PUBLIC_JOIN_LIMITS.perAddress} tries.
Cloudflare carries the traffic. The address changes when cloudflared restarts:
\`beluga status\` shows the current one. \`beluga web --off\` closes it.
`;
}
