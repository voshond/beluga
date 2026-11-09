import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { belugaHome } from '../core/home.js';
import { type WebRoute, json, sameOrigin } from './web.js';

/**
 * Files between a browser and the computer Beluga runs on (docs/web.md): what you drop or
 * pick in the browser is uploaded into ~/.beluga/uploads (the chat and tasks then use its path
 * there, as they would a file on the Mac), and what you save or "show" comes down as a download
 * through a one-time link. Both only for a browser that's let in (these routes run after its
 * session is checked) and only from the page's own origin.
 */

export { MAX_UPLOAD_BYTES } from '../shared/uploads.js';
import { MAX_UPLOAD_BYTES } from '../shared/uploads.js';
/** How long a download link works. */
export const DOWNLOAD_TTL_MS = 60_000;

export const uploadsDir = (): string => path.join(belugaHome(), 'uploads');
/** Uploads are kept this long (a chat or task may still name them), then cleared at a start. */
export const UPLOADS_KEEP_DAYS = 30;

/**
 * Clear what's left over: copies made for downloads (none outlive the daemon) and days of uploads
 * older than UPLOADS_KEEP_DAYS. → how many folders went.
 */
export function sweepUploads(now = Date.now()): number {
  const root = uploadsDir();
  let gone = 0;
  let days: string[];
  try {
    days = readdirSync(root);
  } catch {
    return 0;
  }
  const cutoff = new Date(now - UPLOADS_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const day of days) {
    if (day === '.out' || (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff)) {
      rmSync(path.join(root, day), { recursive: true, force: true });
      gone++;
    }
  }
  return gone;
}

/** RFC 5987's filename*: percent-encoded UTF-8, ' ( ) * included. */
const rfc5987 = (name: string): string => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Names Windows won't make a file of (CON, NUL, COM1…), whatever their extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file name that is only a name: no folders, no dots in front, nothing a shell or Finder minds. */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').replace(/[. ]+$/, '').trim().slice(0, 180);
  if (!clean) return 'file';
  return WINDOWS_RESERVED.test(clean) ? `_${clean}` : clean;
}

interface Pending {
  readonly file: string;
  readonly name: string;
  readonly expiresAt: number;
  /** Delete the file once it's sent (a copy made for this download). */
  readonly temporary: boolean;
}

export class WebFiles {
  private downloads = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A one-time link (relative to the web port) for this file on this computer. */
  offer(file: string, opts: { name?: string; temporary?: boolean } = {}): { url: string; name: string } {
    const st = statSync(file);
    if (!st.isFile()) throw new Error(`${path.basename(file)} isn't a file`);
    const now = this.now();
    for (const [k, p] of this.downloads) if (p.expiresAt <= now) this.forget(k, p);
    const token = randomBytes(18).toString('base64url');
    const name = safeName(opts.name ?? path.basename(file));
    this.downloads = new Map(this.downloads).set(token, { file, name, expiresAt: now + DOWNLOAD_TTL_MS, temporary: opts.temporary ?? false });
    return { url: `/download/${token}`, name };
  }

  /** Where a copy for a download goes (a friend's file fetched first). */
  scratch(name: string): string {
    const dir = path.join(uploadsDir(), '.out', randomBytes(8).toString('hex'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, safeName(name));
  }

  private forget(token: string, p: Pending): void {
    this.downloads = new Map([...this.downloads].filter(([k]) => k !== token));
    if (p.temporary) rmSync(path.dirname(p.file), { recursive: true, force: true });
  }

  /** GET /download/<token> and POST /upload. */
  routes(log?: (line: string) => void): WebRoute[] {
    return [(req, res, url) => this.download(req, res, url), (req, res, url) => this.upload(req, res, url, log)];
  }

  private download(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const m = /^\/download\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
    if (!m || req.method !== 'GET') return false;
    const token = m[1]!;
    const pending = this.downloads.get(token);
    if (!pending || pending.expiresAt <= this.now()) {
      if (pending) this.forget(token, pending);
      json(res, 404, { error: 'This download link has expired. Try again.' });
      return true;
    }
    this.forget(token, { ...pending, temporary: false });
    let size: number;
    try {
      size = statSync(pending.file).size;
    } catch {
      json(res, 404, { error: 'That file is gone' });
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${pending.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${rfc5987(pending.name)}`,
      'cache-control': 'no-store',
    });
    const done = (): void => {
      if (pending.temporary) rmSync(path.dirname(pending.file), { recursive: true, force: true });
    };
    pipeline(createReadStream(pending.file), res).then(done, () => {
      done();
      res.destroy();
    });
    return true;
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL, log?: (line: string) => void): Promise<boolean> {
    if (url.pathname !== '/upload') return false;
    // Turned away before its body is read: close the connection rather than wait for the rest of it.
    const refuse = (status: number, error: string): true => {
      json(res, status, { error }, { connection: 'close' });
      return true;
    };
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    // A page of another site can't post files here (its Origin differs; the cookie is SameSite=Strict too).
    if (!sameOrigin(req.headers.origin, req.headers.host)) return refuse(403, 'Only Beluga’s own page can upload');
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length > MAX_UPLOAD_BYTES) return refuse(413, `Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const name = safeName(url.searchParams.get('name') ?? 'file');
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const dir = path.join(uploadsDir(), day, randomBytes(6).toString('hex'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    let received = 0;
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > MAX_UPLOAD_BYTES || received > length) req.destroy(new Error('Too big'));
    });
    try {
      await pipeline(req, createWriteStream(file, { mode: 0o600 }));
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      log?.(`web: an upload failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 400, { error: 'The upload didn’t finish' });
      return true;
    }
    json(res, 200, { path: file, name, size: received });
    return true;
  }
}
