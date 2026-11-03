import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { belugaEnv } from '../../core/beluga-env.js';
import { hostName, isLoopbackAddress } from '../web.js';

/**
 * `beluga web --tailscale`: the web port on the tailnet over https, through Tailscale Serve (never
 * Funnel: nobody off the tailnet reaches it). `tailscale serve --bg --https=443 http://127.0.0.1:7777`
 * puts it at https://<box>.<tailnet>.ts.net with Tailscale's own certificate.
 *
 * Who gets in (BLG-655, decided: trust your Tailscale login): Serve tells the web port who is
 * asking (Tailscale-User-Login). A request from your own login (this machine's) is let in without
 * a join link; anyone else on the tailnet needs one. Those headers are believed only from
 * tailscaled itself (loopback), under the ts.net name, and only while Serve is on.
 */

export const INSTALL_TAILSCALE = process.platform === 'darwin' ? 'Install Tailscale from https://tailscale.com/download/mac (or `brew install tailscale`) and log in.' : 'Install it with `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.';

/** The Mac app's own command line, when `tailscale` isn't on PATH. */
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export interface TailscaleState {
  /** https://box.tailnet.ts.net */
  readonly url: string;
  /** This machine's Tailscale login: it gets in without a join link. Undefined on a tagged machine (nobody's). */
  readonly login?: string;
}

/** What `tailscale status --json` says about this machine. */
export interface TailscaleSelf {
  readonly name: string;
  readonly login?: string;
}

type Run = (bin: string, args: readonly string[]) => Promise<{ code: number; out: string; err: string }>;

const run: Run = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: String(out), err: String(errOut) });
    });
  });

/** This machine on the tailnet, from `tailscale status --json`; a plain error when it isn't up. */
export function readSelf(json: string): TailscaleSelf {
  let status: { BackendState?: string; Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }> };
  try {
    status = JSON.parse(json) as typeof status;
  } catch {
    throw new Error('Tailscale said something this Beluga can’t read. Is it up to date?');
  }
  if (status.BackendState !== 'Running') throw new Error(`Tailscale isn’t connected here (${status.BackendState ?? 'not running'}). Log in with \`sudo tailscale up\` (or the Tailscale app), then try again.`);
  const name = (status.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) throw new Error('Tailscale gave this machine no name: turn on MagicDNS in the admin console (DNS), then try again.');
  const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
  // A tagged machine belongs to no one ("tagged-devices"): nobody's login is trusted there.
  return { name, ...(login && login.includes('@') ? { login: login.toLowerCase() } : {}) };
}

/** What a failed `tailscale serve` means, in words that say what to do. */
export function serveProblem(text: string): string {
  const t = text.trim();
  if (/access denied|permission|operator|must be root/i.test(t)) return 'Tailscale needs your say-so to serve as you. Run once: `sudo tailscale set --operator=$USER`, then try again.';
  if (/https?.*(not enabled|disabled)|enable https|certificates/i.test(t)) return `Turn on HTTPS certificates for your tailnet (admin console › DNS › HTTPS Certificates), then try again.${t ? `\nTailscale said: ${t.split('\n')[0]}` : ''}`;
  return `tailscale serve didn't work: ${t || 'no reason given'}`;
}

export interface TailscaleReachOptions {
  /** The tailscale program; default `tailscale` (or the Mac app's), BELUGA_TAILSCALE overrides. */
  readonly bin?: string;
  readonly run?: Run;
  readonly log?: (line: string) => void;
}

export class TailscaleReach {
  private current?: TailscaleState & { readonly name: string };

  constructor(private readonly opts: TailscaleReachOptions = {}) {}

  get state(): TailscaleState | undefined {
    return this.current ? { url: this.current.url, ...(this.current.login ? { login: this.current.login } : {}) } : undefined;
  }

  /** The ts.net name the web port must answer to, while Serve is on. */
  get host(): string | undefined {
    return this.current?.name;
  }

  /** The program to run, or a plain error saying how to install Tailscale. */
  private async tailscale(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    const exec = this.opts.run ?? run;
    const bins = this.opts.bin ? [this.opts.bin] : [belugaEnv('TAILSCALE') ?? 'tailscale', ...(process.platform === 'darwin' && existsSync(MAC_APP_CLI) ? [MAC_APP_CLI] : [])];
    for (const bin of bins) {
      try {
        return await exec(bin, args);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
    throw new Error(`Tailscale isn’t installed here. ${INSTALL_TAILSCALE}`);
  }

  /** Who this machine is on the tailnet. */
  async self(): Promise<TailscaleSelf> {
    const status = await this.tailscale(['status', '--json']);
    if (status.code !== 0 && !status.out.trim()) throw new Error(`Tailscale isn’t running here: ${status.err.trim() || 'no answer'}. ${INSTALL_TAILSCALE}`);
    return readSelf(status.out);
  }

  /** Serve the web port (on this computer's loopback) on the tailnet; its https address. */
  async start(port: number): Promise<TailscaleState> {
    const self = await this.self();
    const served = await this.tailscale(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
    if (served.code !== 0) throw new Error(serveProblem(served.err || served.out));
    this.current = { name: self.name, url: `https://${self.name}`, ...(self.login ? { login: self.login } : {}) };
    this.opts.log?.(`web: on the tailnet at ${this.current.url}`);
    return this.state!;
  }

  /** Stop serving on the tailnet (`tailscale serve --https=443 off`). */
  async stop(): Promise<void> {
    this.current = undefined;
    const off = await this.tailscale(['serve', '--https=443', 'off']).catch((err: unknown) => ({ code: 1, out: '', err: err instanceof Error ? err.message : String(err) }));
    // Nothing served there is fine: off is off.
    if (off.code !== 0 && !/not found|no serve config|nothing/i.test(off.err + off.out)) this.opts.log?.(`web: tailscale serve off: ${(off.err || off.out).trim()}`);
  }

  /**
   * The login of a request Serve vouches for as this machine's own, else undefined. Only from
   * tailscaled (loopback), only under the ts.net name, only while Serve is on.
   */
  trusted(req: IncomingMessage): string | undefined {
    const on = this.current;
    if (!on?.login) return undefined;
    if (!isLoopbackAddress(req.socket.remoteAddress) || hostName(req.headers.host) !== on.name) return undefined;
    const login = req.headers['tailscale-user-login'];
    const who = (Array.isArray(login) ? login[0] : login)?.trim().toLowerCase();
    return who && who === on.login ? who : undefined;
  }
}

/** What `beluga web --tailscale` says: the address (a QR of it, for the phone's browser) and who gets in. */
export function tailscaleWords(t: { readonly url: string; readonly login?: string; readonly link: { readonly url: string; readonly expiresAt: number } }, qr: readonly string[] = []): string {
  const own = t.login ? `Your own Tailscale login (${t.login}) gets in without a link, on any of your devices:` : 'This machine is tagged (it belongs to no one), so every browser needs a join link:';
  return `Beluga is on your tailnet at ${t.url}
${own}

  ${t.url}
${qr.length ? `\n${qr.map((l) => `  ${l}`).join('\n')}\n` : ''}
Anyone else on the tailnet needs a join link (once, until ${new Date(t.link.expiresAt).toLocaleTimeString()}):

  ${t.link.url}

Only your tailnet reaches it (Tailscale Serve, never Funnel). \`beluga web --off\` stops it.
`;
}
