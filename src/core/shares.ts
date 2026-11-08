import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { type FsEntry, MAX_DOWNLOAD_BYTES, MAX_FILE_BYTES, type ShareInfo } from '../protocol.js';
import { belugaEnv } from './beluga-env.js';
import type { SecretKind } from './gateway/model.js';

export interface ShareConfig {
  readonly name: string;
  readonly root: string;
  readonly writable: boolean;
  /** Not advertised to the room; only you and `allowed` peers can open it (e.g. a workspace). */
  readonly private?: boolean;
  readonly allowed?: readonly string[];
}

/** Credential stores: never served to peers and never readable by an agent without asking. */
const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud']);
const SECRET_FILE = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|pgpass)$/i,
  /^\.?credentials(\.json)?$/i,
  /^\.(zsh|bash|sh|python|node_repl|psql|mysql|lesshst)_?history$/i,
];
/** Credential folders deeper in a path (e.g. the GitHub CLI's token, the macOS keychains). */
const SECRET_PATHS = [/(^|[\\/])\.config[\\/](gh|hub|gcloud|op|1password|doctl)([\\/]|$)/i, /(^|[\\/])library[\\/]keychains([\\/]|$)/i, /(^|[\\/])\.claude[\\/]\.credentials/i];
/** A project's .env file: you can open and edit it, and your own Claude may read it once you say so. */
const DOTENV = /^\.env(\..*)?$/i;
/** What a project commits to show which variables it needs: no secrets in it. */
const DOTENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/i;
/** Heavy or internal folders that are hidden from peers. */
const HIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

export class ShareError extends Error {}

const MAX_WATCHED = 200;

const segmentsOf = (p: string): string[] => p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());

/** Your home folder: $HOME where it's set (tests set it), else the system's (Windows has no $HOME). */
const userHome = (): string => process.env.HOME || os.homedir();

/** Beluga's own home (~/.beluga): your identity key, settings and trust choices live there. */
export const belugaHomeDir = (): string => path.resolve(belugaEnv('HOME') ?? process.env.KLAUDE_HOME ?? path.join(userHome(), '.beluga'));

/** The Mac's file system ignores case: compare paths the way it does. */
const fold = (p: string): string => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);

/** Where a path really is (its links followed, its case as on disk), for as much of it as exists. */
export function realOf(p: string): string {
  const rest: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    try {
      return path.join(realpathSync.native(at), ...rest);
    } catch {
      if (path.dirname(at) === at) return p;
      rest.unshift(path.basename(at));
    }
  }
}

/** Beluga's home in every form it can be reached by: as named, really, and the old ~/.klaud and ~/.klaude. */
function belugaHomes(): string[] {
  const named = belugaHomeDir();
  const legacy = ['.beluga', '.klaud', '.klaude'].map((name) => path.resolve(userHome(), name));
  return [...new Set([named, realOf(named), ...legacy.flatMap((p) => [p, realOf(p)])].map(fold))];
}

/**
 * Inside Beluga's home, what stays usable: worktrees, chat folders, files put in the outbox, and
 * friends' tasks (the scratch folders they run in, and the files their results brought), and the
 * folder "Your Mac"'s Claude works in (core/assistant: its screenshots and the files it sends you;
 * its session and history beside it stay secret).
 */
const OPEN_IN_HOME = [['workspaces'], ['chats'], ['outbox'], ['tasks', 'work'], ['tasks', 'files'], ['assistant', 'work']];

function secretInHome(abs: string): boolean {
  for (const candidate of new Set([fold(abs), fold(realOf(abs))])) {
    for (const home of belugaHomes()) {
      if (candidate === home) return true;
      if (!candidate.startsWith(home + path.sep)) continue;
      const parts = candidate.slice(home.length + 1).split(path.sep);
      // An open folder and what's in it (but not what's beside it, e.g. tasks/tasks.json).
      if (!OPEN_IN_HOME.some((open) => parts.length >= open.length && open.every((seg, i) => parts[i] === seg))) return true;
    }
  }
  return false;
}

/** In a credential store: ~/.ssh, a CLI's tokens, the keychains, Beluga's own files. */
function inCredentialStore(p: string, segments: readonly string[]): boolean {
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  if (SECRET_PATHS.some((re) => re.test(p))) return true;
  // Beluga's own files in ~/.beluga (identity key, settings, rules, trust choices, history).
  return path.isAbsolute(p) && secretInHome(path.resolve(p));
}

export function isSecretPath(p: string): boolean {
  const segments = segmentsOf(p);
  if (inCredentialStore(p, segments)) return true;
  const base = segments.at(-1) ?? '';
  if (DOTENV_TEMPLATE.test(base)) return false;
  return SECRET_FILE.some((re) => re.test(base));
}

/** The macOS keychains: never sent to anyone, whoever approves. */
const KEYCHAINS = /(^|[\\/])library[\\/]keychains([\\/]|$)/i;

/**
 * A secret no approval sends (BLG-209): Beluga's own private files in ~/.beluga (your identity,
 * settings, rules, trust choices, history) and the keychains. Other secrets can go to a friend
 * when you approve that one request.
 */
export function isNeverSent(p: string): boolean {
  if (KEYCHAINS.test(p)) return true;
  return path.isAbsolute(p) && secretInHome(path.resolve(p));
}

const CLOUD_SEGMENTS = new Set(['.aws', '.azure', '.gcloud', '.kube', '.docker']);
const CLOUD_PATHS = /(^|[\\/])\.config[\\/](gcloud|doctl)([\\/]|$)/i;
const TOKEN_FILE = /^\.(npmrc|netrc|pypirc|git-credentials|pgpass)$/i;
const TOKEN_PATHS = /(^|[\\/])(\.config[\\/](gh|hub|op|1password)|\.claude[\\/]\.credentials)/i;

/** The kind of secret `p` is (its approval says it in words: secretLabel), or undefined when it isn't one (isSecretPath). */
export function secretKindOf(p: string): SecretKind | undefined {
  if (!isSecretPath(p)) return undefined;
  const segments = segmentsOf(p);
  const base = segments.at(-1) ?? '';
  if (segments.includes('.ssh') || /^id_(rsa|ed25519|ecdsa|dsa)$/i.test(base)) return 'ssh-key';
  if (DOTENV.test(base)) return 'dotenv';
  if (segments.some((s) => CLOUD_SEGMENTS.has(s)) || CLOUD_PATHS.test(p)) return 'cloud';
  if (TOKEN_FILE.test(base) || TOKEN_PATHS.test(p) || /^\.?credentials(\.json)?$/i.test(base)) return 'token';
  return 'secret';
}

/** A file a friend's task result brought here (~/.beluga/tasks/files): yours now, whatever its name says. */
export function isReceivedTaskFile(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const homes = belugaHomes();
  // Where it really is counts too: a link in there to your own ~/.ssh is still your key.
  return [path.resolve(p), realOf(path.resolve(p))].every((at) => homes.some((home) => fold(at).startsWith(home + path.sep + fold(path.join('tasks', 'files')) + path.sep)));
}

/**
 * A secret that is a project's .env file, and nothing more: never sent to anyone, but you can open
 * it, and your own Claude can read or change it once you say so (see agent/policy.ts).
 */
export function isDotenvPath(p: string): boolean {
  const segments = segmentsOf(p);
  const base = segments.at(-1) ?? '';
  return DOTENV.test(base) && !DOTENV_TEMPLATE.test(base) && !inCredentialStore(p, segments);
}

/** Hidden from the room. `owner`: you, on your own computer, who also see your .env files. */
export function isDenied(relPath: string, owner = false): boolean {
  return (isSecretPath(relPath) && !(owner && isDotenvPath(relPath))) || segmentsOf(relPath).some((s) => HIDDEN_SEGMENTS.has(s));
}

/** Parse `name=path[:rw]` or `path[:rw]` share specs from the CLI. */
export function parseShareSpec(spec: string, cwd: string): ShareConfig {
  let rest = spec;
  let writable = false;
  if (rest.endsWith(':rw')) {
    writable = true;
    rest = rest.slice(0, -3);
  } else if (rest.endsWith(':ro')) {
    rest = rest.slice(0, -3);
  }
  const eq = rest.indexOf('=');
  const rawPath = eq >= 0 ? rest.slice(eq + 1) : rest;
  const root = path.resolve(cwd, rawPath || '.');
  const name = (eq >= 0 ? rest.slice(0, eq) : path.basename(root)).replace(/[^\w.-]/g, '_').slice(0, 64) || 'share';
  return { name, root, writable };
}

/**
 * Resolve a peer-supplied relative path inside a share root, rejecting
 * traversal (`..`), absolute paths, symlink escapes and denied files (`owner`: you, see isDenied).
 */
export function resolveInShare(share: ShareConfig, relPath: string, owner = false): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').includes('..')) throw new ShareError('Path traversal is not allowed');
  if (isDenied(cleaned, owner)) throw new ShareError('That file is private');
  const root = realRoot(share.root);
  const target = path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) throw new ShareError('Path escapes the share');
  let real = target;
  try {
    real = realpathSync(target);
  } catch {
    return target; // does not exist yet; caller reports ENOENT
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new ShareError('Symlink escapes the share');
  return real;
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

export class ShareService {
  private watcher?: FSWatcher;

  private shares: readonly ShareConfig[];

  constructor(initial: readonly ShareConfig[]) {
    this.shares = initial;
  }

  /** Shares advertised to everyone in the room. */
  get infos(): ShareInfo[] {
    return this.shares.filter((s) => !s.private).map((s) => ({ name: s.name, writable: s.writable }));
  }

  /** Add or replace a share at runtime (workspaces come and go). */
  upsert(share: ShareConfig): void {
    this.shares = [...this.shares.filter((s) => s.name !== share.name), share];
  }

  remove(name: string): void {
    this.shares = this.shares.filter((s) => s.name !== name);
  }

  isPrivate(name: string): boolean {
    return this.shares.find((s) => s.name === name)?.private === true;
  }

  /** Whether `peerId` may open this share (you always can; private shares need an invite). */
  canAccess(name: string, peerId: string, selfId: string): boolean {
    const share = this.shares.find((s) => s.name === name);
    if (!share) return false;
    return peerId === selfId || !share.private || (share.allowed ?? []).includes(peerId);
  }

  get configs(): readonly ShareConfig[] {
    return this.shares;
  }

  find(name: string): ShareConfig {
    const share = this.shares.find((s) => s.name === name);
    if (!share) throw new ShareError(`No share named "${name}"`);
    return share;
  }

  /** Map an absolute path back to (share, relative path) if it lives in a share. */
  locate(absPath: string): { share: string; path: string } | undefined {
    for (const share of this.shares) {
      const root = realRoot(share.root);
      const abs = path.resolve(absPath);
      if (abs === root || abs.startsWith(root + path.sep)) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!isDenied(rel)) return { share: share.name, path: rel };
      }
    }
    return undefined;
  }

  /** `owner`: you, looking at your own files (your .env files show too). */
  async list(shareName: string, relPath: string, owner = false, times = false): Promise<FsEntry[]> {
    const share = this.find(shareName);
    const dir = resolveInShare(share, relPath, owner);
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const base = relPath.replace(/^\/+|\/+$/g, '');
    const rel = (name: string): string => (base ? `${base}/${name}` : name);
    const visible = dirents.filter((d) => !isDenied(rel(d.name), owner));
    const entries = await Promise.all(
      visible.map(async (d): Promise<FsEntry | undefined> => {
        let target = path.join(dir, d.name);
        if (d.isSymbolicLink()) {
          try {
            target = resolveInShare(share, rel(d.name), owner); // hides links pointing outside the share
          } catch {
            return undefined;
          }
        }
        const stat = await fs.stat(target).catch(() => undefined);
        if (!stat) return undefined;
        return { name: d.name, dir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size, ...(times ? { mtime: Math.round(stat.mtimeMs) } : {}) };
      }),
    );
    return entries
      .filter((e): e is FsEntry => e !== undefined)
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 5000);
  }

  async read(shareName: string, relPath: string, owner = false): Promise<{ content: string; truncated: boolean }> {
    const share = this.find(shareName);
    const file = resolveInShare(share, relPath, owner);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) throw new ShareError('That is a directory');
    const handle = await fs.open(file, 'r');
    try {
      const length = Math.min(stat.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, 0);
      if (buf.includes(0)) return { content: '[binary file]', truncated: false };
      return { content: buf.toString('utf8'), truncated: stat.size > MAX_FILE_BYTES };
    } finally {
      await handle.close();
    }
  }

  /** A file's size and when it last changed (ms), without reading it: a picture's cache asks whether it was rewritten. */
  async stat(shareName: string, relPath: string, owner = false): Promise<{ size: number; mtime: number }> {
    const stat = await fs.stat(resolveInShare(this.find(shareName), relPath, owner));
    if (stat.isDirectory()) throw new ShareError('That is a folder; pick a file');
    return { size: stat.size, mtime: Math.round(stat.mtimeMs) };
  }

  /** Read one chunk of any file (binary-safe) for downloads. */
  async readChunk(shareName: string, relPath: string, offset: number, length: number, owner = false): Promise<{ data: Buffer; total: number }> {
    const file = resolveInShare(this.find(shareName), relPath, owner);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) throw new ShareError('That is a folder; pick a file');
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new ShareError(`File is too large to send (max ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB)`);
    const handle = await fs.open(file, 'r');
    try {
      const size = Math.max(0, Math.min(length, stat.size - offset));
      const data = Buffer.alloc(size);
      if (size > 0) await handle.read(data, 0, size, offset);
      return { data, total: stat.size };
    } finally {
      await handle.close();
    }
  }

  /** Watch all shares and report changed files as (share, relative path). */
  private onChange?: (share: string, relPath: string) => void;
  private readonly watched = new Set<string>();

  /**
   * Live updates for files people actually have open. Nothing is crawled up front, so
   * sharing a huge folder (like Desktop) stays instant.
   */
  watch(onChange: (share: string, relPath: string) => void, onError: (message: string) => void = () => undefined): void {
    this.onChange = onChange;
    this.watcher = watch([], { ignoreInitial: true, ignorePermissionErrors: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } });
    let warned = false;
    this.watcher.on('error', (err: unknown) => {
      // Keep a listener attached: an unhandled 'error' event would crash the process.
      if (warned) return;
      warned = true;
      onError(`Live file updates paused: ${err instanceof Error ? err.message : String(err)}`);
    });
    const report = (abs: string): void => {
      const hit = this.locate(abs);
      if (hit) this.onChange?.(hit.share, hit.path);
    };
    this.watcher.on('add', report).on('change', report).on('unlink', report);
  }

  /** Start live updates for one file (called when someone opens it). */
  watchFile(shareName: string, relPath: string): void {
    if (!this.watcher) return;
    let abs: string;
    try {
      abs = resolveInShare(this.find(shareName), relPath);
    } catch {
      return;
    }
    if (this.watched.has(abs)) return;
    if (this.watched.size >= MAX_WATCHED) {
      const oldest = this.watched.values().next().value as string;
      this.watched.delete(oldest);
      this.watcher.unwatch(oldest);
    }
    this.watched.add(abs);
    this.watcher.add(abs);
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = undefined;
    if (!watcher) return;
    const closing = watcher.close();
    // close() strips listeners; swallow late errors from in-flight fs calls so they can't crash us.
    watcher.on('error', () => undefined);
    await closing;
  }
}
