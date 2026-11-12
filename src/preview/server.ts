import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { isSecretPath } from '../core/shares.js';
import { hostName } from '../daemon/web.js';
import { type PreviewPublic, previewPublic } from './public.js';

/**
 * Where preview frames load from (Settings › Experimental › Live previews): a server of its own
 * on 127.0.0.1 at a port the system picks, apart from the daemon's socket and the web port, that
 * serves nothing but previews. Each preview is at /p/<id>/, an id nobody can guess; only the
 * Beluga window may frame it, and only under a loopback host name (no DNS rebinding), or the
 * public preview origin when one is set up for the web port's pages (public.ts).
 */

export const PREVIEW_HOST = '127.0.0.1';

/**
 * The port it asks for first: one address from one run to the next, so whatever a component keeps
 * in the browser stays under one origin (and is cleared as each preview loads) instead of piling
 * up under a new one each time. Taken (another Beluga, a demo): any free one.
 */
export const PREVIEW_PORT = 47791;

/** How long a ticket for the public origin may wait for its frame to load. */
export const TICKET_MS = 2 * 60_000;
/** The query parameter a frame's first load at the public origin carries its ticket in. */
export const TICKET_PARAM = 'beluga_ticket';
const PASS_COOKIE = 'beluga_preview';

const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
};

/** Who may frame a preview: the Mac app (tauri://localhost), its dev server, the demo's browser. */
export const FRAME_ANCESTORS = "tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:* http://127.0.0.1:*";

/** The app's own framers, and the web port's pages when a public preview origin is set up. */
export const frameAncestors = (pub: PreviewPublic | undefined): string => [FRAME_ANCESTORS, ...(pub?.framedBy ?? [])].join(' ');

/** A component's frame: only what this server serves, so nothing in it can be sent off this computer. */
export const componentCsp = (ancestors: string): string =>
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`;

/** An HTML file's frame: a page you made, so its inline scripts and CDNs run too, but it connects only here. */
export const pageCsp = (ancestors: string): string =>
  `default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors ${ancestors}`;

export const COMPONENT_CSP = componentCsp(frameAncestors(previewPublic()));
export const PAGE_CSP = pageCsp(frameAncestors(previewPublic()));

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

export const typeOf = (file: string): string => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** What one preview answers under its /p/<id>/. */
export interface PreviewSite {
  /** `rest`: the path after /p/<id>/ ('' for the page). True when it answered. */
  serve(rest: string, req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>;
}

/** The common headers: never cached, never sniffed, framed only by Beluga. */
export function send(res: ServerResponse, status: number, type: string, body: string | Buffer, csp = COMPONENT_CSP): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': csp });
  res.end(body);
}

/**
 * A file of a page's folder: inside `root` (the worktree) through links too, never a secret, a
 * dot-folder or node_modules' insides beyond what the page names. Undefined: not one to serve.
 */
export async function pageFile(root: string, dir: string, rest: string): Promise<string | undefined> {
  let rel: string;
  try {
    rel = decodeURIComponent(rest.split('?')[0] ?? '');
  } catch {
    return undefined;
  }
  if (rel.includes('\0')) return undefined;
  const base = await realpath(root).catch(() => undefined);
  if (!base) return undefined;
  const wanted = path.resolve(dir, rel);
  const real = await realpath(wanted).catch(() => undefined);
  if (!real) return undefined;
  const inside = path.relative(base, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
  const parts = inside.split(path.sep);
  if (parts.some((p) => p.startsWith('.')) || isSecretPath(inside)) return undefined;
  const info = await stat(real).catch(() => undefined);
  return info?.isFile() ? real : undefined;
}

/** Stream a file with its type. */
export function sendFile(res: ServerResponse, file: string, csp: string): void {
  res.writeHead(200, { 'content-type': typeOf(file), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': csp });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export class PreviewServer {
  private server?: Server;
  private port?: number;
  private starting?: Promise<number>;
  private readonly sites = new Map<string, PreviewSite>();
  /** At the public origin: each preview's pass (its cookie), and the one-time tickets that hand it out. */
  private readonly passes = new Map<string, string>();
  private readonly tickets = new Map<string, { readonly id: string; readonly until: number }>();

  /** `port`: the one to ask for first (0: any free one). `pub`: also reached at a public origin (public.ts). */
  constructor(
    private readonly wanted = PREVIEW_PORT,
    private readonly pub: PreviewPublic | undefined = previewPublic(),
  ) {}

  /** Whether it's listening (it closes when no preview is left). */
  get open(): boolean {
    return Boolean(this.server);
  }

  /** The port it listens on now, if it does. */
  get listening(): number | undefined {
    return this.server ? this.port : undefined;
  }

  /** The server's origin, started the first time it's needed. */
  async origin(): Promise<string> {
    return `http://${PREVIEW_HOST}:${await this.start()}`;
  }

  add(id: string, site: PreviewSite): void {
    this.sites.set(id, site);
  }

  remove(id: string): void {
    this.sites.delete(id);
    this.passes.delete(id);
    for (const [t, v] of this.tickets) if (v.id === id) this.tickets.delete(t);
  }

  /**
   * A one-time ticket for preview `id` at the public origin, handed out only through `preview.open`
   * (a signed-in Beluga session): its frame's first load trades it for the preview's cookie.
   * Undefined without a public origin (loopback needs none).
   */
  ticket(id: string): string | undefined {
    if (!this.pub) return undefined;
    const now = Date.now();
    for (const [t, v] of this.tickets) if (v.until < now) this.tickets.delete(t);
    if (!this.passes.has(id)) this.passes.set(id, randomBytes(24).toString('hex'));
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, { id, until: now + TICKET_MS });
    return ticket;
  }

  /** At the public origin: let in with the preview's cookie, or trade a ticket for it (and say so). */
  private admit(id: string, url: URL, req: IncomingMessage, res: ServerResponse): boolean {
    const pass = this.passes.get(id);
    if (pass && cookieOf(req, PASS_COOKIE) === pass) return true;
    const ticket = url.searchParams.get(TICKET_PARAM);
    const held = ticket ? this.tickets.get(ticket) : undefined;
    if (!pass || !ticket || !held || held.id !== id || held.until < Date.now()) {
      send(res, 401, 'text/plain', 'Open this preview from Beluga');
      return false;
    }
    this.tickets.delete(ticket);
    url.searchParams.delete(TICKET_PARAM);
    const secure = this.pub?.origin.startsWith('https:') ? '; Secure' : '';
    res.writeHead(303, {
      location: `${url.pathname}${url.search}`,
      'set-cookie': `${PASS_COOKIE}=${pass}; Path=/p/${id}/; HttpOnly; SameSite=Lax${secure}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end();
    return false;
  }

  private start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port);
    this.starting ??= this.listen(this.wanted)
      .catch(() => (this.wanted ? this.listen(0) : Promise.reject(new Error('No port for previews'))))
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.request(req, res).catch(() => res.destroy()));
      server.on('clientError', (_err, socket) => socket.destroy());
      server.once('error', reject);
      server.listen(port, this.pub?.listen ?? PREVIEW_HOST, () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        // Never what keeps the daemon running.
        server.unref();
        resolve(this.port);
      });
    });
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = hostName(req.headers.host);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only');
    if (host !== PREVIEW_HOST && host !== 'localhost' && host !== this.pub?.host) return send(res, 421, 'text/plain', 'Not here');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${PREVIEW_HOST}`);
    } catch {
      return send(res, 400, 'text/plain', 'Not an address');
    }
    const m = /^\/p\/([0-9a-f]{32})\/(.*)$/.exec(url.pathname);
    const site = m ? this.sites.get(m[1]!) : undefined;
    if (!site) return send(res, 404, 'text/plain', 'This preview has closed');
    if (this.pub && host === this.pub.host && !this.admit(m![1]!, url, req, res)) return;
    try {
      if (!(await site.serve(`${m![2]!}${url.search}`, req, res))) send(res, 404, 'text/plain', 'Not part of this preview');
    } catch {
      if (!res.headersSent) send(res, 500, 'text/plain', 'The preview stumbled');
      else res.destroy();
    }
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.sites.clear();
  }
}
