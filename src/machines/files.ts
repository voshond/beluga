import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isSecretPath } from '../core/shares.js';
import { MAX_RANGE, type TextRange } from '../shared/text-range.js';

/**
 * A computer's files on this Mac (BLG-791): the pieces of text your screens read there
 * (files.readRange) are kept here, so the file under the pointer, read ahead, opens at once on the
 * click, the next piece as you scroll is already here, and an offline computer's files you looked at
 * stay readable. Only this cache is written on this Mac: memory first, then a folder of its own
 * (~/.beluga/cache/computer-files, never beside ~/.beluga's keys), both capped, the oldest going
 * first. A computer forgotten takes its files with it. Secrets (.env, keys) are never kept.
 *
 * Diffs and content search aren't here: they run on the computer, like every call a screen of yours
 * makes there, and only their results cross the link.
 */

/** How much the memory side keeps, and the folder. */
export const MEMORY_BYTES = 24 * 1024 * 1024;
export const DISK_BYTES = 128 * 1024 * 1024;
/** How long a piece answers a `cache` read without asking the computer again. */
export const FRESH_MS = 15_000;

/** What a screen asked files.readRange for, read from its call (malformed: not cached, the computer answers it). */
const Ask = z.tuple([
  z.object({ owner: z.string().min(1).max(200), share: z.string().min(1).max(200), path: z.string().min(1).max(4096) }).passthrough(),
  z.object({ offset: z.number().int().min(0), length: z.number().int().min(1).max(MAX_RANGE), cache: z.boolean().optional() }).passthrough(),
]);

export interface RangeAsk {
  readonly key: string;
  readonly path: string;
  /** A copy fetched moments ago will do. */
  readonly cache: boolean;
}

export function rangeAsk(args: readonly unknown[]): RangeAsk | undefined {
  const parsed = Ask.safeParse(args);
  if (!parsed.success) return undefined;
  const [at, range] = parsed.data;
  return { key: [at.owner, at.share, at.path, range.offset, range.length].join('\0'), path: at.path, cache: range.cache === true };
}

const Kept = z.object({ id: z.string(), at: z.number(), value: z.object({ content: z.string(), offset: z.number(), total: z.number(), mtime: z.number() }).passthrough() });

export interface Hit {
  readonly value: TextRange;
  /** When it was fetched (ms). */
  readonly at: number;
}

export interface FileCacheOptions {
  /** Its folder; none: memory only. */
  readonly dir?: string;
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

interface MemEntry extends Hit {
  readonly bytes: number;
}

interface DiskEntry {
  readonly bytes: number;
  readonly at: number;
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
/** A computer's folder in the cache: its id hashed, never a name to trip on. */
const folderOf = (machine: string): string => hash(`computer\0${machine}`).slice(0, 24);
const textBytes = (v: TextRange): number => v.content.length * 2 + 128;

export class FileCache {
  /** In use order: the first is the oldest. */
  private readonly mem = new Map<string, MemEntry>();
  private memBytes = 0;
  /** The folder's files by path, listed once from disk the first time it's needed. */
  private disk?: Map<string, DiskEntry>;
  private diskBytes = 0;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: FileCacheOptions = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Bytes kept now, in memory and on disk (tests, and Settings could say it). */
  get size(): { readonly memory: number; readonly disk: number } {
    return { memory: this.memBytes, disk: this.diskBytes };
  }

  async get(machine: string, key: string): Promise<Hit | undefined> {
    const id = `${machine}\0${key}`;
    const m = this.mem.get(id);
    if (m) {
      this.mem.delete(id);
      this.mem.set(id, m);
      return { value: m.value, at: m.at };
    }
    const file = this.fileOf(machine, id);
    if (!file) return undefined;
    const index = await this.index();
    if (!index.has(file)) return undefined;
    try {
      const kept = Kept.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      if (kept.id !== id) throw new Error('Another piece');
      const hit = { value: kept.value as TextRange, at: kept.at };
      this.remember(id, hit);
      return hit;
    } catch {
      this.dropDisk(file);
      return undefined;
    }
  }

  /** Keep a piece a computer sent (a secret's never is). */
  put(machine: string, ask: Pick<RangeAsk, 'key' | 'path'>, value: TextRange): void {
    if (isSecretPath(ask.path)) return;
    const id = `${machine}\0${ask.key}`;
    const hit = { value: value.stale ? (({ stale: _s, ...rest }) => rest)(value) : value, at: this.now() };
    this.remember(id, hit);
    if (this.opts.dir) this.queue(() => this.write(machine, id, hit));
  }

  /** Everything kept for a computer goes (it was forgotten). */
  clear(machine: string): Promise<void> {
    const prefix = `${machine}\0`;
    for (const [id, e] of this.mem) {
      if (!id.startsWith(prefix)) continue;
      this.mem.delete(id);
      this.memBytes -= e.bytes;
    }
    const dir = this.opts.dir;
    if (!dir) return Promise.resolve();
    const folder = path.join(dir, folderOf(machine)) + path.sep;
    return this.queue(async () => {
      const index = await this.index();
      for (const [file, e] of index) {
        if (!file.startsWith(folder)) continue;
        index.delete(file);
        this.diskBytes -= e.bytes;
      }
      await fs.rm(folder, { recursive: true, force: true });
    });
  }

  /** The writes queued so far are done (tests, and before a forget's clear is said done). */
  flush(): Promise<void> {
    return this.writes.then(() => undefined);
  }

  private queue(job: () => Promise<void>): Promise<void> {
    const run = this.writes.then(job).catch((err: unknown) => this.opts.log?.(`machines: file cache: ${err instanceof Error ? err.message : String(err)}`));
    this.writes = run;
    return run;
  }

  private remember(id: string, hit: Hit): void {
    const old = this.mem.get(id);
    if (old) {
      this.mem.delete(id);
      this.memBytes -= old.bytes;
    }
    const bytes = textBytes(hit.value);
    const cap = this.opts.memoryBytes ?? MEMORY_BYTES;
    if (bytes > cap) return;
    this.mem.set(id, { ...hit, bytes });
    this.memBytes += bytes;
    for (const [oldest, e] of this.mem) {
      if (this.memBytes <= cap) break;
      this.mem.delete(oldest);
      this.memBytes -= e.bytes;
    }
  }

  private async index(): Promise<Map<string, DiskEntry>> {
    if (this.disk) return this.disk;
    const index = new Map<string, DiskEntry>();
    const dir = this.opts.dir!;
    const folders = await fs.readdir(dir).catch(() => [] as string[]);
    for (const folder of folders) {
      const files = await fs.readdir(path.join(dir, folder)).catch(() => [] as string[]);
      for (const name of files) {
        const file = path.join(dir, folder, name);
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat?.isFile()) continue;
        index.set(file, { bytes: stat.size, at: stat.mtimeMs });
        this.diskBytes += stat.size;
      }
    }
    // A second caller may have built it meanwhile: keep the first.
    if (this.disk) return this.disk;
    this.disk = index;
    return index;
  }

  private fileOf(machine: string, id: string): string | undefined {
    return this.opts.dir ? path.join(this.opts.dir, folderOf(machine), `${hash(id)}.json`) : undefined;
  }

  private async write(machine: string, id: string, hit: Hit): Promise<void> {
    const file = this.fileOf(machine, id)!;
    const index = await this.index();
    const text = JSON.stringify({ id, at: hit.at, value: hit.value });
    const bytes = Buffer.byteLength(text);
    const cap = this.opts.diskBytes ?? DISK_BYTES;
    if (bytes > cap) return;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, text, { mode: 0o600 });
    const old = index.get(file);
    if (old) this.diskBytes -= old.bytes;
    index.delete(file);
    index.set(file, { bytes, at: hit.at });
    this.diskBytes += bytes;
    if (this.diskBytes <= cap) return;
    const oldest = [...index].sort((a, b) => a[1].at - b[1].at);
    for (const [gone, e] of oldest) {
      if (this.diskBytes <= cap) break;
      index.delete(gone);
      this.diskBytes -= e.bytes;
      await fs.rm(gone, { force: true });
    }
  }

  private dropDisk(file: string): void {
    const e = this.disk?.get(file);
    if (!e) return;
    this.disk!.delete(file);
    this.diskBytes -= e.bytes;
    void fs.rm(file, { force: true }).catch(() => undefined);
  }
}
