import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import { hostname, userInfo } from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_BYTES } from './server.js';
import { StaticFiles, defaultWebRoot } from './web-static.js';

/**
 * The web port: the whole Beluga UI for a browser, apart from the token socket the Mac app and
 * tools use. It serves the built UI and one socket (/ws) that hands a browser the daemon's
 * accept path once it has proved who it is (a session, never the daemon's token). Only a page
 * from this very origin may open that socket, and only under a host name this port answers to
 * (no DNS rebinding of 127.0.0.1).
 */

/** Fixed, so an SSH line or a bookmark stays the same. */
export const WEB_PORT = 7777;
export const WEB_HOST = '127.0.0.1';
/** What the browser's socket sends where a token would go: the web port never reads it. */
export const WEB_HELLO_TOKEN = 'browser-session-cookie';
/** Closing code when a browser's session is revoked. */
export const REVOKED_CLOSE = 4401;

/** Where the daemon takes a browser's socket that is already let in. */
export interface WebSocketDoor {
  adopt(ws: WebSocket): void;
}

/** A route of the web port's own (the join page, …): true when it answered. */
export type WebRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

export interface WebServerOptions {
  readonly door: WebSocketDoor;
  /** 0: any free port. Default WEB_PORT. */
  readonly port?: number;
  /** Default 127.0.0.1: reachable from elsewhere only when asked (`--listen`). */
  readonly host?: string;
  /** The built UI; default defaultWebRoot(). */
  readonly root?: string;
  /** Host names besides loopback and IP addresses the page may be reached by ('*': any). */
  readonly allowedHosts?: readonly string[];
  /** Host names allowed for now, besides those (a public tunnel's, while it's up). */
  readonly extraHosts?: () => readonly string[];
  /** Which browser session this request is, or undefined: its socket is refused. */
  readonly authorize: (req: IncomingMessage) => string | undefined;
  /** Answered first, for anyone (the join page). */
  readonly routes?: readonly WebRoute[];
  /** Static files anyone may fetch, let in or not (what installing the page needs: its manifest and icons). */
  readonly publicFiles?: (pathname: string) => boolean;
  /** Answered for a browser that's let in, before the static files (uploads, downloads). */
  readonly authedRoutes?: readonly WebRoute[];
  /** What a request that isn't let in gets (default: a plain 401). */
  readonly locked?: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
  readonly log?: (line: string) => void;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * The app's own policy (the Mac app's, tauri.conf.json, without Tauri's parts): only its own
 * scripts, its own socket. On the web port a single injected script would be a shell, so it's sent
 * with every file. The socket's origin is named too, for browsers whose 'self' doesn't cover ws:.
 */
export function appCsp(host: string, https: boolean): string {
  const socket = `${https ? 'wss' : 'ws'}://${host}`;
  return `default-src 'self'; connect-src 'self' ${socket}; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddress = (address: string | undefined): boolean => !!address && (LOOPBACK_ADDRESSES.has(address) || address.startsWith('127.'));

/** The name part of a Host header ("[::1]:7777" → "::1"), lowercased; undefined when malformed. */
export function hostName(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 1 ? h.slice(1, end) : undefined;
  }
  const name = h.split(':')[0];
  return name && /^[a-z0-9.-]+$/.test(name) ? name : undefined;
}

/** Whether this port answers to that Host: loopback names and IP addresses always, others when listed. */
export function hostAllowed(host: string | undefined, allowed: readonly string[] = []): boolean {
  const name = hostName(host);
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || isIP(name)) return true;
  return allowed.some((a) => a === '*' || a.toLowerCase() === name);
}

/** Whether a request's Origin is the page's own: same host and port as it asked for, over http(s). */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === new URL(`${url.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Beluga</title>
<body style="font:15px -apple-system,system-ui,sans-serif;background:#f6f4fb;color:#3b3550;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:28rem;text-align:center"><h1 style="font-size:20px">Beluga's web UI isn't built here</h1>
<p>Build it once with <code>npm run build --prefix packages/mac</code>, or set BELUGA_WEB_ROOT to a built copy, then reload.</p></div>`;

export class WebServer {
  private server?: Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly files?: StaticFiles;
  /** Open sockets by session, so a revoked one is cut off at once. */
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(private readonly opts: WebServerOptions) {
    const root = opts.root ?? defaultWebRoot();
    if (root) this.files = new StaticFiles(root);
  }

  get root(): string | undefined {
    return this.files?.root;
  }

  async listen(): Promise<{ host: string; port: number }> {
    const server = createServer((req, res) => void this.request(req, res));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    server.on('clientError', (_err, socket) => socket.destroy());
    // A big upload over a slow link takes a while (Node's default gives up after 5 minutes); headers still must come in 60 s.
    server.requestTimeout = 30 * 60_000;
    this.server = server;
    const host = this.opts.host ?? WEB_HOST;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? WEB_PORT, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return { host, port: (server.address() as AddressInfo).port };
  }

  /** Close every socket of this session (it was revoked). */
  drop(session: string, reason = 'This browser was signed out'): void {
    for (const ws of this.sockets.get(session) ?? []) {
      // Say why, then cut it off now: a browser that never answers the close can't keep its socket.
      ws.close(REVOKED_CLOSE, reason);
      setTimeout(() => ws.terminate(), 250).unref();
    }
    this.sockets.delete(session);
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.close(1001, 'Beluga is shutting down');
    this.sockets.clear();
    const server = this.server;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private hostAllowed(host: string | undefined): boolean {
    const extra = this.opts.extraHosts?.() ?? [];
    return hostAllowed(host, extra.length ? [...(this.opts.allowedHosts ?? []), ...extra] : this.opts.allowedHosts);
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (!this.hostAllowed(req.headers.host)) return end(res, 421, 'Unknown host');
      const url = new URL(req.url ?? '/', 'http://web.invalid');
      for (const route of this.opts.routes ?? []) if (await route(req, res, url)) return;
      // Nothing of Beluga's, not even the UI's files, before a browser is let in.
      const open = (req.method === 'GET' || req.method === 'HEAD') && (this.opts.publicFiles?.(url.pathname) ?? false);
      if (!open && !this.opts.authorize(req)) return this.opts.locked ? this.opts.locked(req, res, url) : end(res, 401, 'Not signed in');
      for (const route of this.opts.authedRoutes ?? []) if (await route(req, res, url)) return;
      if (url.pathname === '/__beluga/endpoint') return json(res, 200, { web: true });
      if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'Method not allowed');
      if (!this.files) return url.pathname === '/' || url.pathname === '/index.html' ? html(res, 503, NOT_BUILT) : end(res, 404, 'Not found');
      const file = this.files.serve(url.pathname, { acceptEncoding: header(req, 'accept-encoding'), ifNoneMatch: header(req, 'if-none-match') });
      if (!file) return end(res, 404, 'Not found');
      const https = req.headers['x-forwarded-proto'] === 'https';
      res.writeHead(file.status, { ...file.headers, 'content-security-policy': appCsp(req.headers.host!, https) });
      res.end(req.method === 'HEAD' ? undefined : file.body);
    } catch (err) {
      this.opts.log?.(`web: ${req.method} ${req.url?.slice(0, 200)} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) end(res, 500, 'Something went wrong');
      else res.destroy();
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return refuse(404, 'Not Found');
    if (!this.hostAllowed(req.headers.host)) return refuse(421, 'Misdirected Request');
    if (!sameOrigin(header(req, 'origin'), req.headers.host)) return refuse(403, 'Forbidden');
    const session = this.opts.authorize(req);
    if (!session) return refuse(401, 'Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const mine = this.sockets.get(session) ?? new Set<WebSocket>();
      this.sockets.set(session, new Set([...mine, ws]));
      ws.once('close', () => {
        const left = [...(this.sockets.get(session) ?? [])].filter((s) => s !== ws);
        if (left.length) this.sockets.set(session, new Set(left));
        else this.sockets.delete(session);
      });
      this.opts.door.adopt(ws);
    });
  }
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function end(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/** The link to the web port: an address that listens everywhere is reached here at 127.0.0.1. */
export function webUrl(host: string, port: number): string {
  const name = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${name}:${port}`;
}

/** Who to ssh in as, here: "kay@box". */
function thisLogin(): string {
  let user = process.env.USER ?? process.env.LOGNAME ?? 'you';
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers): the environment's word will do.
  }
  return `${user}@${hostname()}`;
}

/**
 * For a web port on loopback: how another computer reaches it through SSH, to copy and paste
 * (`beluga connect`, or the plain ssh line for a computer without Beluga). '' for any other address.
 */
export function sshWords(base: string, login: string = thisLogin()): string {
  const url = new URL(base);
  const name = url.hostname.replace(/^\[|\]$/g, '');
  if (name !== 'localhost' && !isLoopbackAddress(name)) return '';
  const port = url.port || '80';
  return `From another computer, through SSH (no port to open here):\n  beluga connect ${login}\nWithout Beluga there, run this on it, then open the link above:\n  ssh -N -L ${port}:${url.hostname}:${port} ${login}\n`;
}

export interface WebArgs {
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  /** Plain http on an address others can reach (`--insecure-http`): never remembered for the next start. */
  readonly insecureHttp?: boolean;
  /** Also a public link through a Cloudflare tunnel (`--public`, reach/public.ts); remembered until turned off. */
  readonly public?: boolean;
  /** Also on the tailnet through Tailscale Serve (`--tailscale`, reach/tailscale.ts); remembered until turned off. */
  readonly tailscale?: boolean;
}

/**
 * Whether plain http on this address keeps the join secret and the cookie off the wire: loopback,
 * or Tailscale's own addresses (100.64.0.0/10, fd7a:115c:a1e0::/48), which WireGuard encrypts.
 * Anything else (0.0.0.0, a LAN or public address) would send them in the clear.
 */
export function privateBind(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return h.startsWith('fd7a:115c:a1e0:');
}

/** Refuse an address that would carry the session in the clear, unless asked for in so many words. */
export function checkBind(args: Pick<WebArgs, 'host' | 'insecureHttp' | 'allowedHosts'>): void {
  if (args.allowedHosts.some((h) => h === '*' || !/^[a-z0-9.-]+$/.test(h))) throw new Error('--allow-host takes a host name (no wildcards)');
  if (privateBind(args.host) || args.insecureHttp) return;
  throw new Error(
    `Listening on ${args.host} would send the join link and the browser's session over plain http, readable on that network. Use the loopback address with an SSH tunnel, Tailscale's address (100.x) or \`tailscale serve\`, or a https tunnel in front of 127.0.0.1. To do it anyway: --insecure-http`,
  );
}

/**
 * Take `beluga web`'s own flags out of its arguments: `--listen [host][:port]` (default
 * 127.0.0.1:7777) and `--allow-host <name>` (a name the page is reached by: a Tailscale or tunnel
 * host). What's left is the daemon's usual config.
 */
export function splitWebArgs(argv: readonly string[]): { web: WebArgs; rest: string[] } {
  let host = WEB_HOST;
  let port = WEB_PORT;
  const allowedHosts: string[] = [];
  let insecureHttp = false;
  let pub = false;
  let tailnet = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag === '--insecure-http') {
      insecureHttp = true;
      continue;
    }
    if (flag === '--public') {
      pub = true;
      continue;
    }
    if (flag === '--tailscale') {
      tailnet = true;
      continue;
    }
    if (flag !== '--listen' && flag !== '--allow-host') {
      rest.push(arg);
      continue;
    }
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value`);
    if (flag === '--allow-host') {
      allowedHosts.push(value.toLowerCase());
      continue;
    }
    const listen = parseListen(value);
    host = listen.host ?? host;
    port = listen.port ?? port;
  }
  return { web: { host, port, allowedHosts, ...(insecureHttp ? { insecureHttp } : {}), ...(pub ? { public: true } : {}), ...(tailnet ? { tailscale: true } : {}) }, rest };
}

/** "0.0.0.0:7777", "7778", "::", "[::1]:7777", "100.64.0.1". */
export function parseListen(value: string): { host?: string; port?: number } {
  const v = value.trim();
  const portOf = (p: string): number => {
    const n = Number(p);
    // 0: any free port (the link says which).
    if (!/^\d+$/.test(p) || n > 65535) throw new Error(`"${p}" isn't a port`);
    return n;
  };
  if (/^\d+$/.test(v)) return { port: portOf(v) };
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(v);
  if (bracket) return { host: bracket[1]!, ...(bracket[2] ? { port: portOf(bracket[2]) } : {}) };
  if (isIP(v) === 6) return { host: v };
  const [host, port, extra] = v.split(':');
  if (!host || extra !== undefined) throw new Error(`"${value}" isn't an address to listen on`);
  return { host, ...(port !== undefined ? { port: portOf(port) } : {}) };
}
