import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaEnv } from '../core/beluga-env.js';
import { belugaHome } from '../core/home.js';
import { joinRoute, locked, sessionCookie, viaHttps } from './web-join.js';
import { type JoinLink, JoinLimiter, type WebSessionInfo, WebSessions } from './web-sessions.js';
import { WebFiles, sweepUploads } from './web-files.js';
import { PublicReach, type PublicReachOptions, type PublicState } from './reach/public.js';
import { TailscaleReach, type TailscaleReachOptions, type TailscaleState } from './reach/tailscale.js';
import { type WebArgs, WEB_HOST, WEB_PORT, type WebSocketDoor, WebServer, checkBind, parseListen, webUrl } from './web.js';

/**
 * The daemon's web access: the web port (opened by `beluga web` or Settings, and again at every
 * start once it was), the browsers let in, and their join links. The API reaches it through
 * webAccessOf(session).
 */

export const webConfigPath = (): string => path.join(belugaHome(), 'web.json');
const WebConfig = z.object({ host: z.string().max(100), port: z.number().int().min(0).max(65535), allowedHosts: z.array(z.string().max(253)).max(20), public: z.boolean().optional(), tailscale: z.boolean().optional() });

export function readWebConfig(file = webConfigPath()): WebArgs | undefined {
  try {
    const parsed = WebConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeWebConfig(config: WebArgs | undefined, file = webConfigPath()): void {
  if (!config) return void rmSync(file, { force: true });
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The web port's number unless asked otherwise: BELUGA_WEB_PORT (the Mac app's end-to-end tests run many, on 0), else 7777. */
function defaultPort(): number {
  const raw = belugaEnv('WEB_PORT');
  const n = Number(raw);
  return raw && /^\d+$/.test(raw) && n <= 65535 ? n : WEB_PORT;
}

/** Don't open the web port (or its public link) at the next start: `beluga web --off` with no Beluga running. */
export const forgetWebConfig = (): void => writeWebConfig(undefined);

export interface WebStatus {
  readonly on: boolean;
  readonly url?: string;
  readonly sessions: readonly WebSessionInfo[];
  /** The public link (`beluga web --public`), while it's on. */
  readonly public?: PublicState;
  /** On the tailnet (`beluga web --tailscale`), while Serve is on. */
  readonly tailscale?: TailscaleState;
}

/** The tailnet address, its trusted login, and a join link under it for anyone else. */
export interface TailscaleLink extends TailscaleState {
  readonly link: JoinLink;
}

/** A public link and a join link under it. */
export interface PublicLink {
  readonly url: string;
  readonly link: JoinLink;
}

export interface WebAccessOptions {
  readonly door: WebSocketDoor;
  readonly root?: string;
  readonly log?: (line: string) => void;
  readonly sessions?: WebSessions;
  /** Remember the port across restarts (off in tests). Default true. */
  readonly remember?: boolean;
  /** How the public link opens its tunnel (tests use a fake). */
  readonly publicReach?: PublicReachOptions;
  /** How Tailscale is asked (tests use a fake binary). */
  readonly tailscaleReach?: TailscaleReachOptions;
}

export class WebAccess {
  readonly sessions: WebSessions;
  /** Uploads from browsers, and one-time download links to them. */
  readonly files = new WebFiles();
  private readonly limiter = new JoinLimiter();
  private server?: WebServer;
  private args?: WebArgs;
  private url?: string;
  private opening?: Promise<string>;
  /** The public link: a Cloudflare tunnel to the web port, while asked for. */
  readonly public: PublicReach;
  private publicWanted = false;
  /** Tailscale Serve in front of the web port, while asked for. */
  readonly tailscale: TailscaleReach;
  private tailscaleWanted = false;

  constructor(private readonly opts: WebAccessOptions) {
    this.sessions = opts.sessions ?? new WebSessions({ onRevoke: (id) => this.server?.drop(id) });
    this.public = new PublicReach({ ...(opts.log ? { log: opts.log } : {}), ...opts.publicReach });
    this.tailscale = new TailscaleReach({ ...(opts.log ? { log: opts.log } : {}), ...opts.tailscaleReach });
    if (opts.remember !== false) sweepUploads();
  }

  get on(): boolean {
    return !!this.server;
  }

  /** Open the web port (or keep the one that's open, unless it's asked elsewhere); its link. */
  async start(want: Partial<WebArgs> = {}): Promise<string> {
    await this.opening?.catch(() => undefined);
    const args: WebArgs = { host: want.host ?? this.args?.host ?? WEB_HOST, port: want.port ?? this.args?.port ?? defaultPort(), allowedHosts: want.allowedHosts ?? this.args?.allowedHosts ?? [], ...(want.insecureHttp ? { insecureHttp: true } : {}) };
    if (this.server && this.url && this.args && sameArgs(this.args, args)) return this.url;
    this.opening = this.open(args);
    return this.opening;
  }

  private async open(args: WebArgs): Promise<string> {
    checkBind(args);
    await this.server?.close();
    this.server = undefined;
    const server = new WebServer({
      door: this.opts.door,
      host: args.host,
      port: args.port,
      allowedHosts: args.allowedHosts,
      extraHosts: () => [this.public.host, this.tailscale.host].filter((h): h is string => !!h),
      ...(this.opts.root ? { root: this.opts.root } : {}),
      // A browser let in, or (BLG-655) your own Tailscale login as Serve vouches for it.
      authorize: (req) => this.sessions.check(sessionCookie(req, viaHttps(req))) ?? tailscaleSession(this.tailscale.trusted(req)),
      routes: [joinRoute(this.sessions, (req) => (this.public.carries(req) ? { limiter: this.public.limiter, who: PublicReach.visitor(req) } : { limiter: this.limiter, who: req.socket.remoteAddress ?? '?' }), this.opts.log)],
      authedRoutes: this.files.routes(this.opts.log),
      publicFiles: isPublicFile,
      locked,
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
    const at = await server.listen();
    this.server = server;
    this.args = { ...args, port: args.port === 0 ? at.port : args.port };
    this.url = webUrl(at.host, at.port);
    // An address that sends the session in the clear isn't opened again by itself at the next start.
    if (!args.insecureHttp) this.remember();
    this.opts.log?.(`web UI on ${this.url}${server.root ? '' : ' (not built)'}`);
    // A public link follows the port it points at.
    if (this.publicWanted) void this.public.start(this.args.port).catch((err: unknown) => this.opts.log?.(`web: public link: ${err instanceof Error ? err.message : String(err)}`));
    if (this.tailscaleWanted) void this.tailscale.start(this.args.port).catch((err: unknown) => this.opts.log?.(`web: tailscale: ${err instanceof Error ? err.message : String(err)}`));
    return this.url;
  }

  private remember(): void {
    if (this.opts.remember === false || !this.args) return;
    writeWebConfig({ host: this.args.host, port: this.args.port, allowedHosts: this.args.allowedHosts, ...(this.publicWanted ? { public: true } : {}), ...(this.tailscaleWanted ? { tailscale: true } : {}) });
  }

  /** The web port's address must be reachable at 127.0.0.1, where a tunnel or Serve sends what comes in. */
  private loopbackPort(what: string): number {
    const args = this.args!;
    if (!args.host.startsWith('127.') && !['localhost', '0.0.0.0', '::'].includes(args.host)) throw new Error(`${what} reaches the web port at 127.0.0.1, and it listens on ${args.host}. \`beluga web --listen 127.0.0.1\` first.`);
    return args.port;
  }

  /**
   * On the tailnet (`beluga web --tailscale`): Tailscale Serve in front of the web port (opened
   * first when it's closed), at https://<box>.<tailnet>.ts.net. Reopened at every start until off.
   */
  async goTailscale(): Promise<TailscaleLink> {
    await this.start();
    const port = this.loopbackPort('Tailscale Serve');
    const state = await this.tailscale.start(port);
    this.tailscaleWanted = true;
    this.remember();
    return { ...state, link: this.sessions.link(state.url) };
  }

  /** Stop serving on the tailnet (the web port stays as it is). */
  async stopTailscale(): Promise<void> {
    this.tailscaleWanted = false;
    await this.tailscale.stop();
    if (this.server) this.remember();
  }

  /**
   * The public link (`beluga web --public`): the web port behind a Cloudflare quick tunnel, opened
   * first when it's closed. Its https address, and a join link under it. Reopened at every start
   * until turned off.
   */
  async goPublic(): Promise<PublicLink> {
    await this.start();
    const port = this.loopbackPort('The public link');
    this.publicWanted = true;
    try {
      const url = await this.public.start(port);
      this.remember();
      return { url, link: this.sessions.link(url) };
    } catch (err) {
      this.publicWanted = false;
      throw err;
    }
  }

  /** Close the public link (the web port stays as it is). */
  stopPublic(): void {
    this.publicWanted = false;
    this.public.stop();
    if (this.server) this.remember();
  }

  /** A one-time join link (opening the port first when it's closed). `listen` as `beluga web --listen`. */
  async link(listen?: string, allowHosts?: readonly string[], insecureHttp?: boolean, via: 'local' | 'tailscale' | 'public' = 'local'): Promise<JoinLink> {
    const url = await this.start({ ...(listen ? parseListen(listen) : {}), ...(allowHosts?.length ? { allowedHosts: allowHosts.map((h) => h.toLowerCase()) } : {}), ...(insecureHttp ? { insecureHttp } : {}) });
    if (via === 'local') return this.sessions.link(url);
    const base = via === 'tailscale' ? this.tailscale.state?.url : this.public.state?.url;
    if (!base) throw new Error(via === 'tailscale' ? 'Beluga isn’t on your tailnet now.' : 'The public link isn’t up now.');
    return this.sessions.link(base);
  }

  /** The ways in this computer offers besides its own: Tailscale, when it's installed and logged in. */
  async ways(): Promise<{ tailscale?: { name: string } }> {
    const self = await this.tailscale.self().catch((err: unknown) => void this.opts.log?.(`web: no Tailscale to offer: ${err instanceof Error ? err.message : String(err)}`));
    return self ? { tailscale: { name: self.name } } : {};
  }

  status(): WebStatus {
    const pub = this.public.state;
    const tailnet = this.tailscale.state;
    return { on: this.on, ...(this.url && this.server ? { url: this.url } : {}), sessions: this.sessions.list(), ...(pub ? { public: pub } : {}), ...(tailnet ? { tailscale: tailnet } : {}) };
  }

  revoke(idOrName: string): WebSessionInfo {
    return this.sessions.revoke(idOrName);
  }

  /** Close the web port and don't open it at the next start (browsers stay let in for when it's back). */
  async stop(): Promise<void> {
    await this.opening?.catch(() => undefined);
    this.publicWanted = false;
    this.public.stop();
    if (this.tailscaleWanted || this.tailscale.state) await this.stopTailscale();
    await this.server?.close();
    this.server = undefined;
    this.url = undefined;
    if (this.opts.remember !== false) writeWebConfig(undefined);
  }

  /** Close the port for the daemon's stop (it opens again at the next start). */
  async close(): Promise<void> {
    await this.opening?.catch(() => undefined);
    this.public.stop();
    await this.server?.close();
    this.server = undefined;
  }
}

/** What Add to Home Screen / Dock fetches without a session: the manifest and the icons, nothing else. */
export const isPublicFile = (pathname: string): boolean => pathname === '/manifest.webmanifest' || pathname === '/favicon.ico' || /^\/icons\/[a-z0-9-]+\.png$/.test(pathname);

/** The socket's name for a browser your Tailscale login vouches for (not a stored session: nothing to revoke but Serve). */
const tailscaleSession = (login: string | undefined): string | undefined => (login ? `tailscale:${login}` : undefined);

const sameArgs = (a: WebArgs, b: WebArgs): boolean => a.host === b.host && (a.port === b.port || b.port === 0) && a.allowedHosts.join() === b.allowedHosts.join();

/** Which web access serves a session (the daemon's), so the API can reach it. */
const access = new WeakMap<object, WebAccess>();
export const attachWebAccess = (session: object, web: WebAccess): void => void access.set(session, web);
export function webAccessOf(session: object): WebAccess {
  const web = access.get(session);
  if (!web) throw new Error('Web access needs Beluga’s daemon.');
  return web;
}
