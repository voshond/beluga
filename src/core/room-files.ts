import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type BodyInput, type BodyOf, CHUNK_BYTES, type FsEntry, MAX_FILE_BYTES } from '../protocol.js';
import { FIRST_RANGE, type RangeOptions, type TextRange } from '../shared/text-range.js';
import { parseLocation } from './mentions.js';
import { type ShareService, isSecretPath } from './shares.js';
import { type Location, type Store, peerName } from './store.js';
import { DEFAULT_DOWNLOAD_DIR, downloadFile, fetchBytes } from './downloads.js';
import { MAX_IMAGE_BYTES, isImagePath } from '../image/decode.js';
import { decodeImageAsync } from '../image/decode-async.js';

export interface RoomFilesDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts?: { to?: string; keep?: boolean }) => boolean;
  readonly shares: ShareService;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  readonly system: (text: string, level?: 'info' | 'warn' | 'error') => void;
  readonly requestTimeoutMs?: number;
  readonly downloadDir?: string;
}

/** In-flight requests remember who must answer, so other peers can't spoof responses. */
type Pending = { peer: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const FS_DEBOUNCE_MS = 250;
const DIR_CACHE_MS = 5_000;

/**
 * Files the Mac app shows as themselves, by extension: images a document shows inline (SVG goes
 * in an <img>, where scripts never run), PDFs its reader draws page by page, and videos it plays
 * (BLG-100).
 */
const DOC_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};
export const MAX_DOC_IMAGE_BYTES = 10 * 1024 * 1024;
/** PDFs are often bigger than a diagram (scans, slides). */
export const MAX_DOC_PDF_BYTES = 40 * 1024 * 1024;
/** A video plays from memory in the reader (a screen recording, a demo). */
export const MAX_DOC_VIDEO_BYTES = 64 * 1024 * 1024;

export const dirKey = (at: Location): string => `${at.owner}:${at.share}/${at.path}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Files across the room: browsing and opening friends' shared folders (live), downloads in
 * encrypted chunks, and serving your own shares to the people allowed to see them.
 */
export class RoomFiles {
  private readonly pending = new Map<string, Pending>();
  private readonly fsTimers = new Map<string, NodeJS.Timeout>();
  private readonly dirFetched = new Map<string, number>();
  private viewerLoad?: { key: string; again: boolean };

  constructor(private readonly deps: RoomFilesDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  private get selfId(): string {
    return this.deps.selfId();
  }

  private send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    return this.deps.send(body, opts);
  }

  private toast(text: string, level?: 'info' | 'success' | 'warn' | 'error'): void {
    this.deps.toast(text, level);
  }

  private system(text: string, level?: 'info' | 'warn' | 'error'): void {
    this.deps.system(text, level);
  }

  /** Cancel what's waiting (Beluga is quitting). */
  stop(): void {
    for (const t of this.fsTimers.values()) clearTimeout(t);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Session closed'));
    }
    this.pending.clear();
  }

  /** Coalesce bursts of file events (builds, git checkouts) into one message per file. */
  queueFsChanged(share: string, relPath: string): void {
    const key = `${share}/${relPath}`;
    clearTimeout(this.fsTimers.get(key));
    this.fsTimers.set(
      key,
      setTimeout(() => {
        this.fsTimers.delete(key);
        // Private files (workspaces, folders shared with a few people) are only announced to those people.
        const body = { kind: 'fs_changed' as const, share, path: relPath };
        if (!this.deps.shares.isPrivate(share)) this.send(body);
        else for (const to of [this.selfId, ...(this.deps.shares.configs.find((c) => c.name === share)?.allowed ?? [])]) this.send(body, { to });
      }, FS_DEBOUNCE_MS),
    );
  }

  async openLocation(at: Location, opts: { by?: string; broadcast?: boolean } = {}): Promise<void> {
    this.store.dispatch({ type: 'viewer_open', at, by: opts.by });
    if (opts.broadcast !== false) {
      // Your .env file isn't the room's business: not even its name goes out.
      const hidden = at.owner === this.selfId && (this.deps.shares.isPrivate(at.share) || isSecretPath(at.path));
      this.send({ kind: 'focus', owner: at.owner, share: at.share, path: at.path, actor: 'human' }, hidden ? { to: this.selfId } : {});
    }
    await this.loadViewer(at);
  }

  openSpec(spec: string): void {
    const loc = parseLocation(spec, this.store.getState().peers);
    if (!loc) {
      this.toast(`Can't open "${spec}". Use /open <name>:<folder>/<file>`, 'warn');
      return;
    }
    void this.openLocation(loc);
  }

  /** Fetch a directory for /open autocomplete (cached for a few seconds). */
  async loadDir(at: Location): Promise<void> {
    const key = dirKey(at);
    const last = this.dirFetched.get(key);
    if (last && Date.now() - last < DIR_CACHE_MS) return;
    this.dirFetched.set(key, Date.now());
    try {
      this.store.dispatch({ type: 'dir_cache', key, entries: await this.listFiles(at) });
    } catch {
      // Not a folder (yet): nothing to suggest.
    }
  }

  async browseTo(at: Location): Promise<void> {
    this.store.dispatch({ type: 'browser_loading', at });
    try {
      const entries = await this.listFiles(at);
      this.store.dispatch({ type: 'browser_entries', at, entries });
    } catch (err) {
      this.store.dispatch({ type: 'browser_error', error: errorText(err) });
    }
  }

  /** Activate a row of the file browser (the one under the screen's cursor). */
  async browserEnter(index: number): Promise<void> {
    const row = this.store.getState().browser.rows[index];
    if (!row) return;
    if (row.target === 'up') return this.browserUp();
    if (row.dir) return this.browseTo(row.target);
    return this.openLocation(row.target);
  }

  async browserUp(): Promise<void> {
    const at = this.store.getState().browser.at;
    if (!at) return;
    if (!at.path) {
      this.store.dispatch({ type: 'browser_root' });
      return;
    }
    await this.browseTo({ ...at, path: at.path.split('/').slice(0, -1).join('/') });
  }

  serveFs(from: string, body: BodyOf<'fs_list'> | BodyOf<'fs_read'> | BodyOf<'fs_fetch'>): Promise<void> {
    if (body.kind === 'fs_fetch') return this.serveChunk(from, body);
    if (body.kind === 'fs_list') {
      return this.reply(from, body.reqId, async () => ({ kind: 'fs_list_result', reqId: body.reqId, ok: true, entries: await this.deps.shares.list(body.share, body.path, from === this.selfId, body.times === true) }), 'fs_list_result');
    }
    this.deps.shares.watchFile(body.share, body.path);
    return this.reply(from, body.reqId, async () => ({ kind: 'fs_read_result', reqId: body.reqId, ok: true, ...(await this.deps.shares.read(body.share, body.path, from === this.selfId)) }), 'fs_read_result');
  }

  private async reply(to: string, reqId: string, fn: () => Promise<BodyInput>, kind: 'fs_list_result' | 'fs_read_result'): Promise<void> {
    try {
      this.send(await fn(), { to });
    } catch (err) {
      this.send({ kind, reqId, ok: false, error: errorText(err) }, { to });
    }
  }

  request<T>(to: string, body: BodyInput & { reqId: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(body.reqId);
        reject(new Error('Peer did not respond in time'));
      }, this.deps.requestTimeoutMs ?? 15_000);
      this.pending.set(body.reqId, { peer: to, resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.send(body, { to })) {
        clearTimeout(timer);
        this.pending.delete(body.reqId);
        reject(new Error('Not connected'));
      }
    });
  }

  settle(from: string, reqId: string, body: { readonly ok: boolean; readonly error?: string }): void {
    const p = this.pending.get(reqId);
    if (!p || p.peer !== from) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    if (body.ok) p.resolve(body);
    else p.reject(new Error(body.error ?? 'Request failed'));
  }

  /** Owner side of a download: send one encrypted chunk, and tell the owner who is downloading. */
  private async serveChunk(from: string, body: BodyOf<'fs_fetch'>): Promise<void> {
    // A picture, PDF or video shown is watched like a text file read (fs_read): written again, it's read again.
    if (body.offset === 0) this.deps.shares.watchFile(body.share, body.path);
    try {
      const { data, total } = await this.deps.shares.readChunk(body.share, body.path, body.offset, CHUNK_BYTES, from === this.selfId);
      if (body.offset === 0 && from !== this.selfId) this.system(`${peerName(this.store.getState(), from)} is downloading ${body.share}/${body.path}`);
      this.send({ kind: 'fs_chunk', reqId: body.reqId, ok: true, data: data.toString('base64'), offset: body.offset, total }, { to: from });
    } catch (err) {
      this.send({ kind: 'fs_chunk', reqId: body.reqId, ok: false, error: errorText(err) }, { to: from });
    }
  }

  /** Download a file from a friend's share into ~/Downloads/Beluga/<friend>/, or to `opts.to` (an absolute path). */
  async download(at: Location, opts: { to?: string } = {}): Promise<string | undefined> {
    const from = peerName(this.store.getState(), at.owner);
    if (!at.path || at.path.endsWith('/')) {
      this.toast('Pick a file to download, not a folder', 'warn');
      return undefined;
    }
    if (opts.to !== undefined && !path.isAbsolute(opts.to)) {
      this.toast('Pick where to save it', 'warn');
      return undefined;
    }
    this.toast(`Downloading ${at.path} from ${from}…`);
    try {
      const saved = await downloadFile(at, from, (to, b) => this.request(to, b), this.store, this.deps.downloadDir ?? DEFAULT_DOWNLOAD_DIR, opts);
      this.system(`Saved ${at.path} from ${from} → ${saved}`);
      this.toast(`Downloaded ${path.basename(saved)}`, 'success');
      return saved;
    } catch (err) {
      this.toast(`Download failed: ${errorText(err)}`, 'error');
      return undefined;
    }
  }

  downloadSpec(spec: string): void {
    const loc = parseLocation(spec, this.store.getState().peers);
    if (!loc) return this.toast(`Can't find "${spec}". Use /get <name>:<folder>/<file>`, 'warn');
    void this.download(loc);
  }

  /**
   * The bytes of an image a document shows (Markdown's `![](diagram.png)`) or of a PDF, fetched the
   * way the viewer fetches an image (the owner decides who may read it), and only those, only so big.
   */
  async readImageFile(at: Location): Promise<{ mediaType: string; bytes: Buffer }> {
    const mediaType = DOC_IMAGE_TYPES[path.extname(at.path).toLowerCase()];
    if (!mediaType) throw new Error('Not an image');
    const max = mediaType === 'application/pdf' ? MAX_DOC_PDF_BYTES : mediaType.startsWith('video/') ? MAX_DOC_VIDEO_BYTES : MAX_DOC_IMAGE_BYTES;
    return { mediaType, bytes: await fetchBytes(at, (to, b) => this.request(to, b), max) };
  }

  /**
   * Which version of a file this is (its size and when it last changed), without reading it, so a
   * picture kept by its path is read again once it's rewritten (BLG-749). Yours: one stat. A
   * friend's: from a listing of its folder, the way their Scratch tab sees it.
   */
  async fileVersion(at: Location): Promise<{ size: number; mtime: number }> {
    if (at.owner === this.selfId) return this.deps.shares.stat(at.share, at.path, true);
    const dir = path.posix.dirname(at.path);
    const name = path.posix.basename(at.path);
    const entry = (await this.listFiles({ ...at, path: dir === '.' ? '' : dir }, { times: true })).find((e) => e.name === name && !e.dir);
    if (!entry) throw new Error(`ENOENT: ${at.path} is not there`);
    return { size: entry.size, mtime: entry.mtime ?? 0 };
  }

  async listFiles(at: Location, opts: { times?: boolean } = {}): Promise<readonly FsEntry[]> {
    const res = await this.request<BodyOf<'fs_list_result'>>(at.owner, { kind: 'fs_list', reqId: randomUUID(), share: at.share, path: at.path, ...(opts.times ? { times: true } : {}) });
    return res.entries ?? [];
  }

  async readFile(at: Location): Promise<{ content: string; truncated: boolean }> {
    const res = await this.request<BodyOf<'fs_read_result'>>(at.owner, { kind: 'fs_read', reqId: randomUUID(), share: at.share, path: at.path });
    return { content: res.content ?? '', truncated: res.truncated ?? false };
  }

  /**
   * One piece of a file's text (BLG-791). Yours: read where it is, refused as a whole read would be,
   * and watched like one. A friend's: their whole read (up to 512 KB), as one piece from the start.
   */
  async readRange(at: Location, range: RangeOptions): Promise<TextRange> {
    if (at.owner === this.selfId) {
      this.deps.shares.watchFile(at.share, at.path);
      return this.deps.shares.readRange(at.share, at.path, range.offset, range.length, true);
    }
    if (range.offset > 0) throw new Error('A friend’s file is read from its start');
    const { content } = await this.readFile(at);
    return { content, offset: 0, total: Buffer.byteLength(content), mtime: 0 };
  }

  /**
   * What the viewer opens with: a file of yours too big to read whole, its first piece (the rest
   * streams as you scroll, BLG-791); anything else, the whole read.
   */
  private async opening(at: Location): Promise<{ content: string; truncated: boolean; next?: number; total?: number }> {
    if (at.owner === this.selfId) {
      const { size } = await this.deps.shares.stat(at.share, at.path, true);
      if (size > MAX_FILE_BYTES) {
        const first = await this.readRange(at, { offset: 0, length: FIRST_RANGE });
        return { content: first.content, truncated: false, ...(first.next !== undefined ? { next: first.next, total: first.total } : {}) };
      }
    }
    return this.readFile(at);
  }

  /**
   * Load the viewer's file. Change notifications can arrive in bursts (or be sent on
   * purpose), so at most one load per file runs at a time; extra requests collapse
   * into a single reload once it finishes.
   */
  async loadViewer(at: Location): Promise<void> {
    const key = `${at.owner}\0${at.share}\0${at.path}`;
    if (this.viewerLoad?.key === key) {
      this.viewerLoad.again = true;
      return;
    }
    const load = { key, again: false };
    this.viewerLoad = load;
    try {
      do {
        load.again = false;
        await this.loadViewerOnce(at);
      } while (load.again && this.viewerLoad === load);
    } finally {
      if (this.viewerLoad === load) this.viewerLoad = undefined;
    }
  }

  private async loadViewerOnce(at: Location): Promise<void> {
    try {
      if (isImagePath(at.path)) {
        const bytes = await fetchBytes(at, (to, b) => this.request(to, b), MAX_IMAGE_BYTES);
        this.store.dispatch({ type: 'viewer_image', at, image: await decodeImageAsync(bytes, at.path) });
        return;
      }
      const { content, truncated, next, total } = await this.opening(at);
      this.store.dispatch({ type: 'viewer_content', at, content, truncated, ...(next !== undefined && total !== undefined ? { next, total } : {}) });
    } catch (err) {
      this.store.dispatch({ type: 'viewer_error', at, error: errorText(err) });
    }
  }
}
