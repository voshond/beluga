import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebhookState, type WebhookTrigger, capPayload } from '../model.js';
import { type TriggerEvent, type WebhookTunnel, clip, firstWords, isObj, str } from './types.js';

/**
 * Webhooks (docs/sentinel.md §1, §7): one local server (127.0.0.1, a random port) behind one
 * Cloudflare quick tunnel, open only while at least one webhook sentinel is on. A post to
 * `/hook/<sentinelId>/<secret>` starts that sentinel: the secret is compared in constant time, a
 * GitHub signature is checked when the sentinel asks for it, bodies over 1 MB are
 * refused, at most 60 posts a minute per sentinel are taken, and everything else is a 404. No
 * answer ever says back what was posted.
 */

export const MAX_BODY = 1024 * 1024;
export const PER_MINUTE = 60;
/** A tunnel that died (or never opened) is tried again after this long. */
const RETRY_MS = 30_000;

/** A new webhook secret: 32 random bytes, hex. */
export const newSecret = (): string => randomBytes(32).toString('hex');

/** Equal, compared in constant time (any lengths: both are hashed first). */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** GitHub's X-Hub-Signature-256: "sha256=" + the HMAC-SHA256 of the raw body with the secret. */
export function githubSignatureOk(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return sameSecret(header, want);
}

/** What a webhook sentinel the server knows needs: its secret, and how its posts are signed. */
export interface HookOf {
  readonly secret: string;
  /** GitHub signs with this one (its webhook form's Secret, Copy Secret), never the URL's. */
  readonly signingSecret?: string;
  readonly signature?: WebhookTrigger['signature'];
}

export interface WebhookHubDeps {
  /** The sentinel behind an id, while it's on and a webhook (none: 404). */
  readonly hook: (sentinelId: string) => HookOf | undefined;
  readonly fire: (sentinelId: string, event: TriggerEvent) => void;
  readonly onState: (state: WebhookState) => void;
  readonly tunnel?: WebhookTunnel;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** A dead tunnel opens again after this long (30 s; the tests' shorter). */
  readonly retryMs?: number;
}

/** A post's headers must come in this long; the whole post in this long. */
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;

const HEADERS = ['x-github-event', 'x-github-delivery', 'x-github-hook-id', 'x-gitlab-event', 'content-type', 'user-agent'];

/** A post as the run sees it: the body (JSON when it reads as JSON), a few headers, and the event's name in words. */
export function webhookEvent(body: Buffer, headers: http.IncomingHttpHeaders): TriggerEvent {
  const text = body.toString('utf8');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Text it stays.
  }
  const head: Record<string, string> = {};
  for (const h of HEADERS) {
    const v = headers[h];
    if (typeof v === 'string') head[h] = clip(v, 200);
  }
  const gh = head['x-github-event'];
  const action = isObj(parsed) ? str(parsed.action) : undefined;
  const summary = gh ? `Webhook from GitHub: ${gh}${action ? ` (${action})` : ''}` : head['x-gitlab-event'] ? `Webhook from GitLab: ${head['x-gitlab-event']}` : 'Webhook: something posted';
  // A big body (up to 1 MB comes in) is kept as the start of its JSON, at most 64 KB, marked truncated.
  return { summary: clip(summary, 120), payload: capPayload({ headers: head, ...(gh ? { event: gh } : {}), body: parsed }) };
}

/** The local server and its tunnel, for every webhook sentinel that's on. */
export class WebhookHub {
  private server?: http.Server;
  private port = 0;
  private tunnel?: { close(): void };
  private url?: string;
  private why?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly on = new Set<string>();
  private readonly posts = new Map<string, number[]>();
  private generation = 0;

  constructor(private readonly deps: WebhookHubDeps) {}

  /** The tunnel's address (no path), once it's up. */
  base(): string | undefined {
    return this.url;
  }

  localPort(): number {
    return this.port;
  }

  /** A webhook sentinel turned on: the server and its tunnel open with the first. */
  add(id: string): void {
    this.on.add(id);
    if (this.on.size === 1) void this.open();
  }

  /** One turned off (or removed): the last one closes them. */
  remove(id: string): void {
    if (!this.on.delete(id)) return;
    this.posts.delete(id);
    if (!this.on.size) this.close();
  }

  has = (id: string): boolean => this.on.has(id);

  close(): void {
    this.generation++;
    clearTimeout(this.retry);
    this.tunnel?.close();
    this.tunnel = undefined;
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = undefined;
    this.port = 0;
    const had = this.url !== undefined || this.why !== undefined;
    this.url = undefined;
    this.why = undefined;
    if (had) this.publish();
  }

  /** Open (or already open): the server listens, then the tunnel is asked for. */
  private async open(): Promise<void> {
    const gen = ++this.generation;
    if (!this.server) {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('clientError', (_err, socket) => socket.destroy());
      // A slow sender doesn't hold a connection open.
      server.headersTimeout = HEADERS_TIMEOUT_MS;
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      this.server = server;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      if (gen !== this.generation) return;
      this.port = (server.address() as AddressInfo).port;
    }
    this.publish();
    await this.openTunnel(gen);
  }

  private async openTunnel(gen: number): Promise<void> {
    const tunnel = this.deps.tunnel;
    if (!tunnel) {
      this.why = 'Webhooks need the Beluga app (its tunnel)';
      return this.publish();
    }
    // Only this tunnel's death tears it down: one that died before (and was replaced in the same
    // generation by a retry) can say so again without closing its successor.
    let mine: { close(): void } | undefined;
    let diedEarly: string | undefined;
    const died = (why: string): void => {
      if (gen !== this.generation) return;
      this.deps.log?.(`sentinel: the webhook tunnel stopped: ${why}`);
      this.lost(`The tunnel stopped (${clip(why, 80)}); it opens again in a moment`);
    };
    try {
      const t = await tunnel(this.port, (why) => {
        if (!mine) diedEarly ??= why;
        else if (this.tunnel === mine) died(why);
      });
      if (gen !== this.generation || !this.on.size) return t.close();
      mine = t;
      if (diedEarly !== undefined) {
        t.close();
        return died(diedEarly);
      }
      this.tunnel = t;
      this.url = t.url.replace(/\/+$/, '');
      this.why = undefined;
      this.publish();
    } catch (err) {
      if (gen !== this.generation) return;
      this.deps.log?.(`sentinel: no webhook tunnel: ${firstWords(err)}`);
      this.lost(`The tunnel didn’t open (${firstWords(err)}); it tries again in a moment`);
    }
  }

  private lost(why: string): void {
    this.tunnel?.close();
    this.tunnel = undefined;
    this.url = undefined;
    this.why = why;
    this.publish();
    if (!this.on.size) return;
    clearTimeout(this.retry);
    const gen = this.generation;
    this.retry = setTimeout(() => gen === this.generation && void this.openTunnel(gen), this.deps.retryMs ?? RETRY_MS);
    this.retry.unref?.();
  }

  private publish(): void {
    this.deps.onState(this.on.size ? { ready: this.url !== undefined, ...(this.url ? { url: this.url } : {}), ...(this.why ? { why: this.why } : {}) } : { ready: false });
  }

  /** Too many posts this minute for this sentinel? (Counts this one.) */
  private limited(id: string): boolean {
    const now = (this.deps.now ?? Date.now)();
    const recent = (this.posts.get(id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PER_MINUTE) {
      this.posts.set(id, recent);
      return true;
    }
    recent.push(now);
    this.posts.set(id, recent);
    return false;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const answer = (status: number, text: string): void => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(`${text}\n`);
    };
    const nope = (): void => {
      answer(404, 'Not found');
      req.resume();
    };
    const m = /^\/hook\/([\w-]{1,80})\/([^/?#]{1,200})\/?(?:\?.*)?$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) return nope();
    const id = m[1]!;
    const hook = this.on.has(id) ? this.deps.hook(id) : undefined;
    if (!hook || !sameSecret(m[2]!, hook.secret)) return nope();
    if (this.limited(id)) {
      answer(429, 'Too many posts: at most 60 a minute');
      req.resume();
      return;
    }
    // Too big: said, then the connection goes (nothing more of it is read).
    const tooBig = (): void => {
      answer(413, 'Too big: at most 1 MB');
      res.once('finish', () => req.destroy());
    };
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY) return tooBig();
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        tooBig();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      const header = (name: string): string | undefined => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : undefined;
      };
      if (hook.signature === 'github' && (!hook.signingSecret || !githubSignatureOk(body, header('x-hub-signature-256'), hook.signingSecret))) return answer(401, 'The signature doesn’t match');
      try {
        this.deps.fire(id, webhookEvent(body, req.headers));
      } catch {
        // Paused or gone meanwhile: the post still arrived.
      }
      answer(202, 'Accepted');
    });
  }
}
