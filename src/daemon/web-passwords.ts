import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { belugaHome } from '../core/home.js';

type ScryptOptions = { N: number; r: number; p: number; maxmem: number };

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>;

const COST = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;
const MIN_PASSWORD = 10;

export const webPasswordsPath = (): string => path.join(belugaHome(), 'web-passwords.json');
const legacyPath = (): string => path.join(belugaHome(), 'web.json');

const Account = z.object({ name: z.string().regex(/^[a-z0-9_.-]{1,64}$/i), hash: z.string().startsWith('scrypt$').max(300) });
type Account = z.infer<typeof Account>;
const AccountsFile = z.object({ users: z.array(Account).max(50) });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, KEY_BYTES, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: COST.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
};

const readAccounts = (file: string): Account[] | undefined => {
  try {
    const parsed = AccountsFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.users : undefined;
  } catch {
    return undefined;
  }
};

let decoy: Promise<string> | undefined;

export class WebPasswords {
  private readonly file: string;

  constructor(file = webPasswordsPath(), legacy = legacyPath()) {
    this.file = file;
    if (readAccounts(file)) return;
    const moved = readAccounts(legacy);
    if (moved?.length) this.save(moved);
  }

  private accounts(): Account[] {
    return readAccounts(this.file) ?? [];
  }

  private save(accounts: readonly Account[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ users: accounts }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get any(): boolean {
    return this.accounts().length > 0;
  }

  get names(): string[] {
    return this.accounts().map((a) => a.name);
  }

  async set(name: string, password: string): Promise<void> {
    if (!Account.shape.name.safeParse(name).success) throw new Error('A name is letters, digits, dot, dash or underscore (up to 64)');
    if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters`);
    const hash = await hashPassword(password);
    this.save([...this.accounts().filter((a) => a.name !== name), { name, hash }]);
  }

  remove(name: string): boolean {
    const before = this.accounts();
    const after = before.filter((a) => a.name !== name);
    if (after.length === before.length) return false;
    this.save(after);
    return true;
  }

  async check(name: string, password: string): Promise<string | undefined> {
    const account = this.accounts().find((a) => a.name === name);
    if (account) return (await verifyPassword(password, account.hash)) ? account.name : undefined;
    decoy ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await decoy);
    return undefined;
  }
}
