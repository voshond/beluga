import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { belugaEnv } from '../core/beluga-env.js';
import { belugaHome } from '../core/home.js';

/**
 * The built UI (packages/mac's `vite build`) as the web port serves it: hashed assets cached for a
 * year, everything else revalidated, text compressed (br, else gzip) once and kept.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
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
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/** Worth compressing (images, fonts and audio already are). */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.map', '.svg', '.wasm', '.txt', '.bcmap', '.ttf', '.otf', '.ico']);
/** Vite names what it bundles `name-<hash>.ext` under assets/: those never change. */
const HASHED = /^assets\/.+[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
/** Smaller than this isn't worth the CPU. */
const MIN_COMPRESS = 1024;

/** private: a shared cache (a tunnel's CDN) must not hand the UI to browsers that aren't let in. */
export const IMMUTABLE = 'private, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

export interface StaticFile {
  readonly status: 200 | 304;
  readonly headers: Record<string, string>;
  readonly body?: Buffer;
}

type Encoding = 'br' | 'gzip' | 'identity';

/**
 * Where the built UI is: BELUGA_WEB_ROOT, the server install's web/ (scripts/build-server.mjs, its
 * root from the launcher), a packaged build's web/ beside the engine, or the repo's packages/mac/dist.
 */
export function defaultWebRoot(env: NodeJS.ProcessEnv = process.env, here = path.dirname(fileURLToPath(import.meta.url))): string | undefined {
  const server = belugaEnv('SERVER_ROOT', env);
  const candidates = [env.BELUGA_WEB_ROOT, server && path.join(server, 'web'), path.resolve(here, '../web'), path.resolve(here, '../../packages/mac/dist')];
  return candidates.find((dir): dir is string => !!dir && existsSync(path.join(dir, 'index.html')));
}

/** The client's best encoding we make, from its Accept-Encoding. */
export function pickEncoding(accept: string | undefined): Encoding {
  const offered = new Map<string, number>();
  for (const part of (accept ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    offered.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const ok = (name: string): boolean => (offered.get(name) ?? offered.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return 'identity';
}

/**
 * The file a URL path names inside root, or undefined: no way out of root (.., encoded slashes,
 * NUL), no dotfiles, no folders.
 */
export function resolveInRoot(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return undefined;
  const base = path.resolve(root);
  const file = path.resolve(base, ...parts);
  if (file !== base && !file.startsWith(base + path.sep)) return undefined;
  return file;
}

/** Beluga's own files: never served, wherever the root points. */
const PRIVATE_NAMES = new Set(['daemon.json', 'daemon.lock', 'web-sessions.json', 'settings.json', 'identity.json']);

export class StaticFiles {
  /** Compressed copies, by file, encoding and modification time. */
  private readonly packed = new Map<string, Buffer>();
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    // Beluga's home (daemon.json and its token, sessions, keys) is never a web root, nor inside one.
    const home = path.resolve(belugaHome());
    if (home === this.root || home.startsWith(this.root + path.sep)) throw new Error(`Won't serve ${this.root}: Beluga's own files are in it`);
  }

  /** What to answer for this path (relative to root, already checked), or undefined for not found. */
  serve(urlPath: string, req: { acceptEncoding?: string; ifNoneMatch?: string }): StaticFile | undefined {
    const file = resolveInRoot(this.root, urlPath === '/' ? '/index.html' : urlPath);
    if (!file || PRIVATE_NAMES.has(path.basename(file).toLowerCase())) return undefined;
    let size: number;
    let mtime: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) return undefined;
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return undefined;
    }
    const rel = path.relative(this.root, file).split(path.sep).join('/');
    const ext = path.extname(file).toLowerCase();
    const encoding = COMPRESSIBLE.has(ext) && size >= MIN_COMPRESS ? pickEncoding(req.acceptEncoding) : 'identity';
    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}${encoding === 'identity' ? '' : `-${encoding}`}"`;
    const headers: Record<string, string> = {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': HASHED.test(rel) ? IMMUTABLE : REVALIDATE,
      etag,
      vary: 'Accept-Encoding',
    };
    if (encoding !== 'identity') headers['content-encoding'] = encoding;
    if (req.ifNoneMatch && req.ifNoneMatch.split(',').some((t) => t.trim() === etag)) return { status: 304, headers };
    const body = encoding === 'identity' ? readFileSync(file) : this.compressed(file, encoding, mtime);
    return { status: 200, headers: { ...headers, 'content-length': String(body.length) }, body };
  }

  private compressed(file: string, encoding: 'br' | 'gzip', mtime: number): Buffer {
    const key = `${encoding}:${mtime}:${file}`;
    const hit = this.packed.get(key);
    if (hit) return hit;
    const raw = readFileSync(file);
    // Quality 9 / level 9: most of the gain at a fraction of max quality's time, done once per file.
    const body = encoding === 'br' ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : gzipSync(raw, { level: 9 });
    for (const old of this.packed.keys()) if (old.endsWith(`:${file}`) && old.startsWith(`${encoding}:`)) this.packed.delete(old);
    this.packed.set(key, body);
    return body;
  }
}
