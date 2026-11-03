import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { readDaemonInfo } from '../daemon/files.js';
import { MAX_FRAME_BYTES } from '../daemon/server.js';
import type { DaemonInfo } from '../ipc/protocol.js';
import { LoginThrottle, SESSION_MS, type WebAuth } from './auth.js';

/**
 * Beluga in a browser, from anywhere (`cli.js web`): a sign-in page, then the Mac app's built
 * window (packages/mac/dist) and its WebSocket, proxied to the daemon on 127.0.0.1. The daemon's
 * token never leaves this machine: the gateway puts it into the window's hello on its way through.
 * Whoever signs in can run terminals and agents here, so it's as good as a shell on this computer.
 */

export interface WebGatewayOptions {
  readonly auth: WebAuth;
  /** The built window (packages/mac/dist). */
  readonly dist: string;
  readonly port?: number;
  /** Where to listen. Default 127.0.0.1: the tunnel (or a reverse proxy) is the way in. */
  readonly host?: string;
  /** Where the daemon is (default: ~/.beluga/daemon.json, read on every connection, so a restarted daemon is found). */
  readonly daemon?: () => DaemonInfo | undefined;
  readonly log?: (line: string) => void;
}

export const WS_PATH = '/__beluga/ws';
const COOKIE = 'beluga_session';
/** Placeholder the window sends as its token; the gateway puts the real one in. */
const GATEWAY_TOKEN = 'web-gateway';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Not no-referrer: then a browser sends "Origin: null" with the sign-in form, and sameOrigin() turns it away.
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
};

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return out;
}

const loopback = (addr: string | undefined): boolean => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/** Requests from the tunnel or a proxy on this machine may say where they came from; others may not. */
function forwarded(req: IncomingMessage): { proto: 'http' | 'https'; address: string } {
  const peer = req.socket.remoteAddress ?? '';
  if (!loopback(peer)) return { proto: 'http', address: peer };
  const first = (h: string | string[] | undefined): string | undefined => (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim() || undefined;
  return {
    proto: first(req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http',
    address: first(req.headers['cf-connecting-ip']) ?? first(req.headers['x-forwarded-for']) ?? peer,
  };
}

/** A browser's request from a page of this same site (or none at all: not a browser). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET' || req.method === 'HEAD';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(message?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beluga · Sign in</title>
<style>
:root{--bg:#f6f4fb;--card:#fff;--ink:#2b2838;--muted:#6f6a80;--line:#e4e0ef;--accent:#8b7fd6;--accent-ink:#fff;--warn:#c4566b}
@media (prefers-color-scheme: dark){:root{--bg:#18171d;--card:#22212a;--ink:#ece9f5;--muted:#a19bb4;--line:#34323f;--accent:#a99ef0;--accent-ink:#18171d;--warn:#ef8fa1}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px;display:grid;gap:14px}
h1{margin:0 0 4px;font-size:20px;font-weight:600}p{margin:0;color:var(--muted);font-size:13px}
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
input{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
.err{color:var(--warn)}
</style></head><body>
<form method="post" action="/login">
<div><h1>Beluga</h1><p>Sign in to open Beluga on this computer.</p></div>
${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ''}
<label>Name<input name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign In</button>
</form></body></html>`;
}

async function body(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Too big');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** WebSocket close codes a peer may send on (1005, 1006 and 1015 are only ever reported). */
const sendableCode = (code: number): number => (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1011);

export class WebGateway {
  private server?: Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly throttle = new LoginThrottle();
  /** Open windows per session cookie, closed when it signs out. */
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(private readonly opts: WebGatewayOptions) {}

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private daemon(): DaemonInfo | undefined {
    return (this.opts.daemon ?? readDaemonInfo)();
  }

  async listen(): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.log(`web: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 8420, this.opts.host ?? '127.0.0.1', resolve);
    });
    return (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, 'Beluga web is stopping');
    this.wss.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private send(res: ServerResponse, status: number, type: string, text: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const { proto, address } = forwarded(req);
    const cookie = cookies(req).get(COOKIE);
    const user = this.opts.auth.session(cookie);

    if (url.pathname === '/login') {
      if (req.method === 'GET') return user ? this.redirect(res, '/') : this.send(res, 200, 'text/html; charset=utf-8', loginPage(), { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
      if (req.method !== 'POST') return this.send(res, 405, 'text/plain', 'Method not allowed');
      if (!sameOrigin(req)) return this.send(res, 403, 'text/plain', 'Forbidden');
      const wait = this.throttle.wait(address);
      if (wait > 0) {
        this.log(`web: sign-in from ${address} held back (${Math.ceil(wait / 60000)} min)`);
        return this.send(res, 429, 'text/html; charset=utf-8', loginPage(`Too many tries. Try again in ${Math.ceil(wait / 60000)} minutes.`), { 'retry-after': String(Math.ceil(wait / 1000)) });
      }
      const form = new URLSearchParams(await body(req));
      const name = await this.opts.auth.check(form.get('user') ?? '', form.get('password') ?? '');
      if (!name) {
        this.throttle.failed(address);
        this.log(`web: wrong password from ${address}`);
        return this.send(res, 401, 'text/html; charset=utf-8', loginPage('That name and password don’t match.'));
      }
      this.throttle.succeeded(address);
      const value = this.opts.auth.startSession(name);
      this.log(`web: ${name} signed in from ${address}`);
      return this.redirect(res, '/', this.cookie(value, proto, SESSION_MS / 1000));
    }

    if (url.pathname === '/logout') {
      if (req.method !== 'POST' || !sameOrigin(req)) return this.send(res, 405, 'text/plain', 'Method not allowed');
      this.signOut(cookie);
      return this.redirect(res, '/login', this.cookie('', proto, 0));
    }

    if (!user) {
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) return this.redirect(res, '/login');
      return this.send(res, 401, 'application/json', JSON.stringify({ error: 'Sign in first' }));
    }

    if (url.pathname === '/__beluga/endpoint') {
      const info = this.daemon();
      if (!info) return this.send(res, 503, 'application/json', JSON.stringify({ error: 'Beluga is not running on this computer. Start it with: beluga daemon --keep-alive' }));
      return this.send(res, 200, 'application/json', JSON.stringify({ url: WS_PATH, token: GATEWAY_TOKEN, version: info.version }));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return this.send(res, 405, 'text/plain', 'Method not allowed');
    return this.serveFile(url.pathname, req, res);
  }

  private cookie(value: string, proto: 'http' | 'https', maxAge: number): Record<string, string> {
    return { 'set-cookie': `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}${proto === 'https' ? '; Secure' : ''}` };
  }

  private redirect(res: ServerResponse, to: string, extra: Record<string, string> = {}): void {
    res.writeHead(303, { ...SECURITY_HEADERS, location: to, 'cache-control': 'no-store', ...extra });
    res.end();
  }

  private signOut(cookie: string | undefined): void {
    if (!cookie) return;
    this.opts.auth.endSession(cookie);
    for (const ws of this.sockets.get(cookie) ?? []) ws.close(4401, 'Signed out');
    this.sockets.delete(cookie);
  }

  private serveFile(pathname: string, req: IncomingMessage, res: ServerResponse): void {
    const root = path.resolve(this.opts.dist);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return this.send(res, 400, 'text/plain', 'Bad path');
    }
    let file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return this.send(res, 404, 'text/plain', 'Not found');
    const isFile = (f: string): boolean => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    };
    if (!isFile(file)) {
      // A page's own path (no extension): the window. A missing file: not found.
      if (path.extname(rel)) return this.send(res, 404, 'text/plain', 'Not found');
      file = path.join(root, 'index.html');
      if (!existsSync(file)) return this.send(res, 503, 'text/plain', `Beluga's window isn't built yet. Run: npm run build (in packages/mac)`);
    }
    const ext = path.extname(file).toLowerCase();
    const immutable = file.startsWith(path.join(root, 'assets') + path.sep);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': String(statSync(file).size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, why: string): void => {
      socket.end(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== WS_PATH) return refuse(404, 'Not Found');
    // A WebSocket isn't bound by the same-origin rule: only pages of this site may open one.
    if (!req.headers.origin || !sameOrigin(req)) return refuse(403, 'Forbidden');
    const cookie = cookies(req).get(COOKIE);
    const user = this.opts.auth.session(cookie);
    if (!user || !cookie) return refuse(401, 'Unauthorized');
    const info = this.daemon();
    if (!info) return refuse(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.bridge(ws, info, cookie, user, forwarded(req).address));
  }

  /** One window's socket, piped to its own connection to the daemon. */
  private bridge(client: WebSocket, info: DaemonInfo, cookie: string, user: string, address: string): void {
    const set = this.sockets.get(cookie) ?? new Set<WebSocket>();
    set.add(client);
    this.sockets.set(cookie, set);
    this.log(`web: ${user} attached from ${address}`);

    const upstream = new WebSocket(`ws://127.0.0.1:${info.port}`, { maxPayload: MAX_FRAME_BYTES });
    const pending: Array<{ data: RawData | string; binary: boolean }> = [];
    let hello = false;
    let alive = true;

    const toDaemon = (data: RawData, binary: boolean): void => {
      let out: RawData | string = data;
      if (!hello && !binary) {
        hello = true;
        try {
          const frame = JSON.parse(data.toString()) as { t?: string; token?: string };
          if (frame.t === 'hello') out = JSON.stringify({ ...frame, token: info.token });
        } catch {
          // Not JSON: the daemon turns it away.
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(out, { binary });
      else pending.push({ data: out, binary });
    };

    client.on('message', toDaemon);
    upstream.on('open', () => {
      for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary });
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });

    // Tunnels drop sockets that stay quiet: ping the window now and then.
    client.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return client.terminate();
      alive = false;
      client.ping();
    }, 30_000);
    ping.unref();

    const done = (): void => {
      clearInterval(ping);
      set.delete(client);
      if (!set.size) this.sockets.delete(cookie);
    };
    client.on('close', (code, reason) => {
      done();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(sendableCode(code), reason);
    });
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN) client.close(sendableCode(code), reason);
    });
    client.on('error', () => upstream.terminate());
    upstream.on('error', (err) => {
      this.log(`web: daemon connection failed: ${err.message}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011, 'Beluga is not answering');
      else client.terminate();
    });
  }
}
