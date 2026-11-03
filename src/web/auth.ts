import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Who may open Beluga from a browser (`cli.js web`): accounts with a password, and the sessions
 * they've signed in with. Kept in ~/.beluga/web.json (0600). Passwords are stored as scrypt hashes,
 * sessions as SHA-256 of their cookie, so the file alone signs no one in.
 */

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
/** A session lasts this long since it signed in. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export interface WebUser {
  readonly name: string;
  /** scrypt$N$r$p$salt$hash, base64. */
  readonly hash: string;
}

interface StoredSession {
  readonly user: string;
  /** sha256 of the cookie value, hex. */
  readonly id: string;
  readonly expires: number;
}

export interface WebAuthFile {
  users: WebUser[];
  sessions: StoredSession[];
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A hash nobody's password matches, checked against when the name is unknown so timing doesn't tell names apart. */
let decoy: Promise<string> | undefined;

export class WebAuth {
  private data: WebAuthFile;

  constructor(private readonly file: string) {
    this.data = WebAuth.read(file);
  }

  static read(file: string): WebAuthFile {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WebAuthFile>;
      return { users: Array.isArray(raw.users) ? raw.users : [], sessions: Array.isArray(raw.sessions) ? raw.sessions : [] };
    } catch {
      return { users: [], sessions: [] };
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get users(): readonly string[] {
    return this.data.users.map((u) => u.name);
  }

  /** Add the account, or change its password (which signs it out everywhere). */
  async setPassword(name: string, password: string): Promise<void> {
    if (!/^[a-z0-9_.-]{1,64}$/i.test(name)) throw new Error('A name is letters, digits, dot, dash or underscore');
    if (password.length < 10) throw new Error('Use a password of at least 10 characters');
    const hash = await hashPassword(password);
    this.data.users = [...this.data.users.filter((u) => u.name !== name), { name, hash }];
    this.data.sessions = this.data.sessions.filter((s) => s.user !== name);
    this.save();
  }

  /** The account, when the password is right. */
  async check(name: string, password: string): Promise<string | undefined> {
    const user = this.data.users.find((u) => u.name === name);
    if (!user) {
      decoy ??= hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(password, await decoy);
      return undefined;
    }
    return (await verifyPassword(password, user.hash)) ? user.name : undefined;
  }

  /** A new session's cookie value. */
  startSession(user: string, now = Date.now()): string {
    const value = randomBytes(32).toString('base64url');
    this.data.sessions = [...this.data.sessions.filter((s) => s.expires > now), { user, id: digest(value), expires: now + SESSION_MS }];
    this.save();
    return value;
  }

  /** Whose session this cookie is, while it lasts and the account still exists. */
  session(value: string | undefined, now = Date.now()): string | undefined {
    if (!value) return undefined;
    const id = digest(value);
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s || s.expires <= now || !this.data.users.some((u) => u.name === s.user)) return undefined;
    return s.user;
  }

  endSession(value: string | undefined): void {
    if (!value) return;
    const id = digest(value);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.sessions.length !== before) this.save();
  }
}

/**
 * Wrong passwords: a few per address, then that address waits; and a ceiling across all
 * addresses, so many addresses can't guess either (signing in then waits for everyone).
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    private readonly perAddress = 5,
    private readonly overall = 30,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  private recent(list: number[], now: number): number[] {
    return list.filter((t) => now - t < this.windowMs);
  }

  /** Milliseconds until this address may try again (0: now). */
  wait(address: string, now = Date.now()): number {
    const mine = this.recent(this.failures.get(address) ?? [], now);
    this.all = this.recent(this.all, now);
    const blockedBy = mine.length >= this.perAddress ? mine : this.all.length >= this.overall ? this.all : undefined;
    return blockedBy ? Math.max(1, this.windowMs - (now - blockedBy[0]!)) : 0;
  }

  failed(address: string, now = Date.now()): void {
    this.failures.set(address, [...this.recent(this.failures.get(address) ?? [], now), now]);
    this.all.push(now);
    if (this.failures.size > 10_000) for (const [k, v] of this.failures) if (!this.recent(v, now).length) this.failures.delete(k);
  }

  succeeded(address: string): void {
    this.failures.delete(address);
  }
}
