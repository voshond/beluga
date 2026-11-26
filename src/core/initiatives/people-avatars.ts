import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AVATAR_MAX, avatarMime } from '../../net/mesh/avatars.js';
import { writeText } from './files.js';
import type { Person } from './people.js';

const FETCH_TIMEOUT_MS = 10_000;
const SHA = /^[0-9a-f]{64}$/;

export type Fetcher = (url: string, init: { readonly signal: AbortSignal; readonly redirect: 'follow' }) => Promise<{ readonly ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Directory people's pictures, fetched once from their `avatar` link and kept by checksum under
 * `dir` (the app's CSP draws no remote image): index.json maps each link to its checksum.
 */
export class PeopleAvatars {
  private index: Record<string, string>;
  private readonly failed = new Set<string>();

  constructor(
    private readonly dir: string | null,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.index = this.readIndex();
  }

  private readIndex(): Record<string, string> {
    if (!this.dir) return {};
    try {
      const raw = JSON.parse(readFileSync(path.join(this.dir, 'index.json'), 'utf8')) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && SHA.test(e[1])));
    } catch {
      return {};
    }
  }

  /** Each person whose picture is here, by slug → checksum. */
  shas(people: readonly Person[]): Record<string, string> {
    return Object.fromEntries(people.flatMap((p) => (p.avatar && this.index[p.avatar] ? [[p.slug, this.index[p.avatar]!]] : [])));
  }

  /** Fetches the pictures not kept yet: true when one came. A link that fails isn't tried again until restart. */
  async sync(people: readonly Person[]): Promise<boolean> {
    if (!this.dir) return false;
    const missing = [...new Set(people.flatMap((p) => (p.avatar && /^https:\/\//i.test(p.avatar) && !this.index[p.avatar] && !this.failed.has(p.avatar) ? [p.avatar] : [])))];
    let changed = false;
    for (const url of missing) {
      const sha = await this.fetchOne(url).catch(() => undefined);
      if (!sha) {
        this.failed.add(url);
        continue;
      }
      this.index = { ...this.index, [url]: sha };
      changed = true;
    }
    if (changed) writeText(path.join(this.dir, 'index.json'), `${JSON.stringify(this.index, null, 2)}\n`);
    return changed;
  }

  private async fetchOne(url: string): Promise<string | undefined> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    timer.unref();
    try {
      const res = await this.fetcher(url, { signal: abort.signal, redirect: 'follow' });
      if (!res.ok) return undefined;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > AVATAR_MAX || !avatarMime(bytes)) return undefined;
      const sha = createHash('sha256').update(bytes).digest('hex');
      mkdirSync(this.dir!, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir!, sha);
      writeFileSync(`${file}.${process.pid}.tmp`, bytes, { mode: 0o600 });
      renameSync(`${file}.${process.pid}.tmp`, file);
      return sha;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A kept picture's type and bytes (base64), if it's here. */
  read(sha: string): { readonly mime: string; readonly b64: string } | undefined {
    if (!this.dir || !SHA.test(sha)) return undefined;
    try {
      const bytes = readFileSync(path.join(this.dir, sha));
      const mime = avatarMime(bytes);
      return mime ? { mime, b64: bytes.toString('base64') } : undefined;
    } catch {
      return undefined;
    }
  }
}
