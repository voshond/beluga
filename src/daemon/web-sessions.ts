import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../core/home.js';

/**
 * Browsers let into the web port (docs/web.md): each is a device of yours, like a phone.
 * A one-time join link (`/join#<128-bit secret>`, 10 minutes, one use) is traded for a session
 * cookie; only the cookie's hash is kept, in ~/.beluga/web-sessions.json (0600), with what it
 * is (browser, OS), when it joined and when it was last seen. Revoking one forgets it at once.
 */

export const JOIN_TTL_MS = 10 * 60_000;
/** A browser not seen for this long has to join again. */
export const IDLE_MS = 90 * 24 * 60 * 60_000;
/** Join links open at once (older ones are dropped). */
const MAX_LINKS = 20;
/** last seen is written at most this often per browser. */
const SEEN_EVERY_MS = 60_000;
const MAX_SESSIONS = 100;

export const webSessionsPath = (): string => path.join(belugaHome(), 'web-sessions.json');

const Stored = z.object({
  id: z.string().regex(/^[a-f0-9]{8,32}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().max(80),
  browser: z.string().max(40),
  os: z.string().max(40),
  createdAt: z.number(),
  lastSeenAt: z.number(),
});
type Stored = z.infer<typeof Stored>;
const StoredFile = z.object({ sessions: z.array(Stored).max(MAX_SESSIONS) });

/** What the CLI and Settings show of a browser: never its hash. */
export interface WebSessionInfo {
  readonly id: string;
  readonly name: string;
  readonly browser: string;
  readonly os: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface JoinLink {
  readonly url: string;
  readonly expiresAt: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const token = (bytes: number): string => randomBytes(bytes).toString('base64url');

/** "Chrome", "macOS" from a User-Agent: enough to tell your browsers apart. */
export function describeBrowser(ua: string | undefined): { browser: string; os: string } {
  const u = ua ?? '';
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\/|FxiOS\//.test(u) ? 'Firefox' : /Chrome\/|CriOS\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /CrOS/.test(u) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'a computer';
  return { browser, os };
}

export interface WebSessionsOptions {
  readonly file?: string;
  readonly now?: () => number;
  /** A browser was revoked: cut its sockets off. */
  readonly onRevoke?: (id: string) => void;
}

export class WebSessions {
  private sessions = new Map<string, Stored>();
  /** Open join links: secret hash → when it expires. */
  private links = new Map<string, number>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly onRevoke: (id: string) => void;

  constructor(opts: WebSessionsOptions = {}) {
    this.file = opts.file ?? webSessionsPath();
    this.now = opts.now ?? Date.now;
    this.onRevoke = opts.onRevoke ?? (() => undefined);
    this.load();
  }

  /** A new one-time join link under this base URL (http://127.0.0.1:7777). */
  link(base: string): JoinLink {
    const now = this.now();
    const live = [...this.links].filter(([, exp]) => exp > now).slice(-(MAX_LINKS - 1));
    const secret = token(16);
    const expiresAt = now + JOIN_TTL_MS;
    this.links = new Map([...live, [sha256(secret), expiresAt]]);
    return { url: `${base.replace(/\/+$/, '')}/join#${secret}`, expiresAt };
  }

  /** Trade a join link's secret for a session: its cookie value, or undefined (wrong, used or expired). */
  redeem(secret: string, userAgent: string | undefined): { cookie: string; session: WebSessionInfo } | undefined {
    const key = sha256(secret);
    const expires = this.links.get(key);
    if (expires === undefined) return undefined;
    this.links = new Map([...this.links].filter(([k]) => k !== key));
    const now = this.now();
    if (expires <= now) return undefined;
    const cookie = token(32);
    const { browser, os } = describeBrowser(userAgent);
    const stored: Stored = { id: randomBytes(6).toString('hex'), hash: sha256(cookie), name: this.uniqueName(`${browser} on ${os}`), browser, os, createdAt: now, lastSeenAt: now };
    // The least recently seen go when there are too many (cut off like a revoke).
    const byRecent = [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const evicted = byRecent.slice(MAX_SESSIONS - 1);
    this.sessions = new Map([...byRecent.slice(0, MAX_SESSIONS - 1), stored].map((s) => [s.hash, s]));
    this.save();
    for (const gone of evicted) this.onRevoke(gone.id);
    return { cookie, session: info(stored) };
  }

  /** Which browser this cookie value is (its id), or undefined. Notes it was seen. */
  check(cookie: string | undefined): string | undefined {
    if (!cookie || cookie.length > 200) return undefined;
    const hash = sha256(cookie);
    const found = this.sessions.get(hash);
    if (!found) return undefined;
    const now = this.now();
    if (now - found.lastSeenAt > IDLE_MS) {
      this.forget(found.id);
      return undefined;
    }
    if (now - found.lastSeenAt >= SEEN_EVERY_MS) {
      this.sessions = new Map(this.sessions).set(hash, { ...found, lastSeenAt: now });
      this.save();
    }
    return found.id;
  }

  list(): WebSessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(info);
  }

  /** Revoke a browser by id or name; what it was, or an error saying why not. */
  revoke(idOrName: string): WebSessionInfo {
    const want = idOrName.trim().toLowerCase();
    const byId = [...this.sessions.values()].find((s) => s.id === want);
    const byName = [...this.sessions.values()].filter((s) => s.name.toLowerCase() === want);
    const found = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!found) throw new Error(byName.length > 1 ? `Several browsers are called "${idOrName}": revoke one by its id (${byName.map((s) => s.id).join(', ')})` : `No browser called "${idOrName}"`);
    this.forget(found.id);
    return info(found);
  }

  private forget(id: string): void {
    this.sessions = new Map([...this.sessions].filter(([, s]) => s.id !== id));
    this.save();
    this.onRevoke(id);
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.sessions.values()].map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  private load(): void {
    try {
      const parsed = StoredFile.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) this.sessions = new Map(parsed.data.sessions.map((s) => [s.hash, s]));
    } catch {
      // None yet.
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

const info = (s: Stored): WebSessionInfo => ({ id: s.id, name: s.name, browser: s.browser, os: s.os, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt });

/**
 * Wrong join attempts allowed per address, and in all, per window: a 128-bit secret can't be
 * guessed, but nobody gets to try.
 */
export class JoinLimiter {
  private failures: Array<{ at: number; who: string }> = [];

  constructor(
    private readonly perAddress = 10,
    private readonly total = 50,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  allowed(who: string): boolean {
    const since = this.now() - this.windowMs;
    this.failures = this.failures.filter((f) => f.at > since);
    return this.failures.length < this.total && this.failures.filter((f) => f.who === who).length < this.perAddress;
  }

  failed(who: string): void {
    this.failures = [...this.failures, { at: this.now(), who }];
  }
}
