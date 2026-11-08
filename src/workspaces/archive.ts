import { type Dirent, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { folderSize } from './disk.js';
import { parseWorktreeList } from './git.js';
import { deleteFolderInBackground, removeWorktreeKeepingBranch } from './others.js';
import { ArchiveError, LONG_MS, RAW_ARGS, RAW_ENV, assertSettled, fingerprint, git, gitLiteral, ignoredByProject, ignoredIn, pack, run, snapshot, submoduleOnlyHere, submodulesIn, tryGit, unpackKeeping, untrackedDirs } from './archive-git.js';
import { type RegenRule, regenRule, remakeSteps } from './regenerable.js';
import { SENT_DIR } from '../shared/scratch-dir.js';

/**
 * A smart archive of a worktree: nothing of yours is lost, and what can be made again doesn't
 * take space. What git sees (changes, staged files, untracked files) goes into a snapshot
 * commit kept in the repo under refs/klaud/archive/<id>: git keeps it compressed and shares what
 * it already has. Of what git ignores, dependencies, build output and caches (see
 * regenerable.ts, and only what the project's own .gitignore ignores) are thrown away;
 * everything else (.env, local databases, git repos of yours inside it…) is packed into one
 * xz-compressed file. Then the folder goes; its branch stays. Restoring brings the folder back
 * exactly as it was, staging included; the thrown-away parts come back from `remake`.
 *
 * It refuses rather than lose anything git keeps in the worktree's own folder: a merge or rebase
 * in progress, a submodule's unpushed work. The snapshot lives in the project's repo, so an
 * archive comes back only while that repo is there.
 */

export { ArchiveError } from './archive-git.js';

export interface ArchiveManifest {
  readonly version: 1;
  readonly id: string;
  /** Where the worktree was, its branch and the commit it was on. */
  readonly dir: string;
  readonly branch?: string;
  readonly head?: string;
  /** The snapshot commit: its tree is the folder as it was; its second parent's tree, the staging. */
  readonly snapshot: string;
  /** The packed ignored files (in the archive's folder), when there were any. */
  readonly keptFile?: string;
  readonly keptBytes: number;
  /** What was thrown away, how big, and what makes it again. */
  readonly dropped: ReadonlyArray<{ readonly path: string; readonly what: string; readonly bytes: number }>;
  readonly freedBytes: number;
  readonly remake: readonly string[];
  readonly archivedAt: number;
  /** Everything was saved, but some of the folder couldn't be removed (it's set aside on restore). */
  readonly leftover?: true;
}

export interface ArchivePlan {
  readonly drop: ReadonlyArray<{ readonly path: string; readonly rule: RegenRule; readonly bytes: number }>;
  /** Ignored files and folders that are kept (relative, folders ending in "/"). */
  readonly keep: readonly string[];
  readonly dropBytes: number;
  readonly remake: readonly string[];
}

export type ArchivePhase = 'saving' | 'compressing' | 'removing';

/** An archive's plan as words and sizes (for a screen to show before you archive or free space). */
export interface ArchivePreview {
  readonly drop: ReadonlyArray<{ readonly path: string; readonly what: string; readonly bytes: number }>;
  readonly dropBytes: number;
  /** Ignored files of yours that are kept (the first few), and how many in all. */
  readonly keep: readonly string[];
  readonly keepCount: number;
  readonly remake: readonly string[];
}

export const previewOf = (p: ArchivePlan): ArchivePreview => ({ drop: p.drop.map((d) => ({ path: d.path, what: d.rule.what, bytes: d.bytes })), dropBytes: p.dropBytes, keep: p.keep.slice(0, 20), keepCount: p.keep.length, remake: p.remake });

const REF = (id: string): string => `refs/klaud/archive/${id}`;
const SAFE_ID = /^[\w.-]{1,128}$/;
const KEPT = 'kept.tar.xz';
const MANIFEST = 'manifest.json';
/** A folder that keeps changing while it's archived: tries this many times, then gives up. */
const ATTEMPTS = 2;

/** Worktrees being archived or restored now (one at a time each). */
const busy = new Set<string>();

async function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(id)) throw new ArchiveError('It’s already being archived or restored');
  busy.add(id);
  try {
    return await fn();
  } finally {
    busy.delete(id);
  }
}

/** Without what's inside another entry (a kept folder takes everything in it). */
function outermost(rels: readonly string[]): string[] {
  const dirs = rels.filter((r) => r.endsWith('/'));
  return rels.filter((r) => !dirs.some((d) => d !== r && r.startsWith(d)));
}

/** How deep to look for build output inside a folder the project ignores whole. */
const NESTED_DEPTH = 6;

/**
 * Folders made again inside a folder the project ignores whole (android/app/build, .gradle…):
 * relative, ending in "/". Never inside a git repo of yours (what it tracks isn't throwaway) or a link.
 */
function regenUnder(dir: string, folder: string): Array<{ rel: string; rule: RegenRule }> {
  const found: Array<{ rel: string; rule: RegenRule }> = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > NESTED_DEPTH || existsSync(path.join(dir, rel, '.git'))) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = `${rel}${e.name}/`;
      const rule = regenRule(dir, sub);
      if (rule) found.push({ rel: sub, rule });
      else walk(sub, depth + 1);
    }
  };
  walk(folder, 0);
  return found;
}

/** A folder as the fewest paths that leave out these folders inside it. */
function without(dir: string, folder: string, out: ReadonlySet<string>): string[] {
  if (![...out].some((o) => o.startsWith(folder))) return [folder];
  let entries: Dirent[];
  try {
    entries = readdirSync(path.join(dir, folder), { withFileTypes: true });
  } catch {
    return [folder];
  }
  return entries.flatMap((e) => {
    const rel = e.isDirectory() ? `${folder}${e.name}/` : `${folder}${e.name}`;
    if (out.has(rel)) return [];
    return e.isDirectory() ? without(dir, rel, out) : [rel];
  });
}

/** The copies of what you sent Claude in a worktree (see core/sent-files.ts): never kept by an archive. */
const SENT = `${SENT_DIR}/`;
const SENT_RULE: RegenRule = { what: 'copies of files you sent Claude', names: [] };

/** Whether what would be kept holds the sent copies (a real folder, never a link). */
function sentIn(dir: string, kept: readonly string[]): boolean {
  if (!kept.some((rel) => rel.startsWith(SENT) || (rel.endsWith('/') && SENT.startsWith(rel)))) return false;
  try {
    return lstatSync(path.join(dir, SENT_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What an archive would throw away and keep, without touching anything. Only what git lists as
 * ignored is ever thrown away, as git lists it: a folder only when git ignores all of it.
 * `archiving`: the worktree goes, so the copies of what you sent Claude go too (freeing space keeps them).
 */
export async function planArchive(dir: string, opts: { readonly archiving?: boolean } = {}): Promise<ArchivePlan> {
  const entries = await ignoredIn(dir);
  const candidates = entries.map((rel) => ({ rel, rule: regenRule(dir, rel) })).filter((c): c is { rel: string; rule: RegenRule } => Boolean(c.rule));
  const theirs = await ignoredByProject(
    dir,
    candidates.map((c) => c.rel),
  );
  const kept = outermost(entries.filter((rel) => !theirs.has(rel)));
  // A folder the project ignores whole (an Android project, a vendored app): what's made again inside it goes too.
  const ignoredFolders = await ignoredByProject(
    dir,
    kept.filter((rel) => rel.endsWith('/') && !regenRule(dir, rel)),
  );
  const inside = [...ignoredFolders].flatMap((folder) => regenUnder(dir, folder));
  const drop = [...candidates.filter((c) => theirs.has(c.rel)), ...inside];
  const nestedDrops = new Set(inside.map((d) => d.rel));
  const listed = kept.flatMap((rel) => (ignoredFolders.has(rel) ? without(dir, rel, nestedDrops) : [rel]));
  // Copies of what you sent Claude (the originals are yours elsewhere): they go with the worktree.
  const sent = opts.archiving === true && sentIn(dir, listed);
  const keep = sent ? listed.flatMap((rel) => (rel.startsWith(SENT) ? [] : SENT.startsWith(rel) ? without(dir, rel, new Set([SENT])) : [rel])) : listed;
  if (sent) drop.push({ rel: SENT, rule: SENT_RULE });
  const sized = await Promise.all(drop.map(async (d) => ({ path: d.rel, rule: d.rule, bytes: (await folderSize(path.join(dir, d.rel))) ?? 0 })));
  return { drop: sized, keep, dropBytes: sized.reduce((n, d) => n + d.bytes, 0), remake: remakeSteps(sized.map((d) => d.rule)) };
}

/** The archive's folder (one per worktree id). */
const folderOf = (archivesDir: string, id: string): string => {
  if (!SAFE_ID.test(id)) throw new ArchiveError('Not an archive id');
  return path.join(archivesDir, id);
};

export function readManifest(archivesDir: string, id: string): ArchiveManifest | undefined {
  try {
    const m = JSON.parse(readFileSync(path.join(folderOf(archivesDir, id), MANIFEST), 'utf8')) as ArchiveManifest;
    return m.version === 1 && typeof m.snapshot === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}

export interface ArchiveOptions {
  /** The repo's main checkout (where `git worktree` runs). */
  readonly repo: string;
  readonly dir: string;
  /** The worktree's id (names the archive and its ref). */
  readonly id: string;
  readonly archivesDir: string;
  readonly onPhase?: (phase: ArchivePhase) => void;
}

/** What's saved of a folder: its snapshot, what's packed and how that was (the same twice in a row: nothing changed meanwhile). */
interface Saved {
  readonly tree: string;
  readonly keep: readonly string[];
  readonly print: string;
}
const sameSave = (a: Saved, b: Saved): boolean => a.tree === b.tree && a.keep.join('\0') === b.keep.join('\0') && a.print === b.print;

/** Any file under a folder (only empty folders inside: git keeps none of them, so it's packed). */
function hasFiles(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((e) => !e.isDirectory() || hasFiles(path.join(dir, e.name)));
}

/**
 * Refuse what an archive can't keep: a submodule with work only here (or files it ignores that
 * aren't made again), a repo inside whose git data lives somewhere else (a .git file).
 * → whether there are submodules (they're checked out again on restore), and empty folders to keep.
 */
async function checkKeepable(dir: string): Promise<{ submodules: boolean; empty: string[] }> {
  const subs = await submodulesIn(dir);
  for (const sub of subs) {
    const at = path.join(dir, sub);
    const only = (await submoduleOnlyHere(at)) ?? ((await planArchive(at)).keep.length ? 'files it ignores that aren’t made again (like .env)' : undefined);
    if (only) throw new ArchiveError(`The submodule ${sub} has ${only}. Commit and push them in it (or move them out) first, then archive.`);
  }
  const empty: string[] = [];
  for (const rel of await untrackedDirs(dir)) {
    const at = path.join(dir, rel);
    if (lstatSync(path.join(at, '.git'), { throwIfNoEntry: false })?.isFile()) throw new ArchiveError(`${rel.replace(/\/$/, '')} is a git checkout whose history lives somewhere else (its .git is a file). Move it out first, then archive.`);
    if (!hasFiles(at)) empty.push(rel);
  }
  return { submodules: subs.length > 0, empty };
}

/**
 * Remove the folder once everything's saved. Read-only folders inside (some package caches)
 * are made writable first; whatever still can't go is left (and set aside on restore), the
 * archive kept either way. → whether something was left.
 */
async function removeFolder(repo: string, dir: string): Promise<boolean> {
  try {
    // Set aside and deleted in the background: deleting a big folder in place froze the Mac.
    await removeWorktreeKeepingBranch(repo, dir, true);
    return existsSync(dir);
  } catch {
    await run('chmod', ['-R', 'u+w', dir], { cwd: repo, timeoutMs: LONG_MS }).catch(() => undefined);
    // Not rmSync: a big folder (node_modules) would freeze the daemon, and every window with it.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined); // what's left stays; the archive has everything
    await tryGit(repo, ['worktree', 'prune']);
    return existsSync(dir);
  }
}

/** Archive a worktree: save what's yours, throw away what's made again, remove the folder (its branch stays). */
export function archiveWorktree(o: ArchiveOptions): Promise<ArchiveManifest> {
  return exclusive(o.id, async () => {
    if (!existsSync(o.dir) || !lstatSync(o.dir).isDirectory()) throw new ArchiveError(`${o.dir} isn’t there`);
    // One archive per worktree: a second would replace what the first kept.
    if (readManifest(o.archivesDir, o.id)) throw new ArchiveError('It’s already archived. Restore it first.');
    await assertSettled(o.dir);
    const { submodules, empty } = await checkKeepable(o.dir);
    const folder = folderOf(o.archivesDir, o.id);
    const work = `${folder}.partial`;
    for (let attempt = 1; ; attempt++) {
      // Past this, the archive is saved: nothing undoes it, whatever fails after.
      let saved = false;
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      try {
        o.onPhase?.('saving');
        const plan = await planArchive(o.dir, { archiving: true });
        const branch = await tryGit(o.dir, ['symbolic-ref', '--short', '--quiet', 'HEAD']);
        const snap = await snapshot(o.dir, `Beluga archive of ${path.basename(o.dir)}`);
        const keep = outermost([...plan.keep, ...snap.nested.map((n) => `${n}/`), ...empty]);
        const print = fingerprint(o.dir, keep);
        o.onPhase?.('compressing');
        let keptBytes = 0;
        if (keep.length) {
          await pack(o.dir, keep, path.join(work, KEPT));
          keptBytes = lstatSync(path.join(work, KEPT)).size;
        }
        // Written to meanwhile (an agent, a dev server, you): save it again, so nothing new is lost.
        const again = await snapshot(o.dir, 'check');
        const againPlan = await planArchive(o.dir, { archiving: true });
        const keepAgain = outermost([...againPlan.keep, ...again.nested.map((n) => `${n}/`), ...empty]);
        if (!sameSave({ tree: snap.tree, keep, print }, { tree: again.tree, keep: keepAgain, print: fingerprint(o.dir, keepAgain) })) {
          if (attempt < ATTEMPTS) continue;
          throw new ArchiveError('It kept changing while it was being archived. Try again when nothing is working in it.');
        }
        const manifest: ArchiveManifest = {
          version: 1,
          id: o.id,
          dir: o.dir,
          ...(branch ? { branch } : {}),
          ...(snap.head ? { head: snap.head } : {}),
          snapshot: snap.commit,
          ...(keep.length ? { keptFile: KEPT } : {}),
          keptBytes,
          dropped: plan.drop.map((d) => ({ path: d.path, what: d.rule.what, bytes: d.bytes })),
          freedBytes: plan.dropBytes,
          remake: submodules ? ['git submodule update --init --recursive', ...plan.remake] : plan.remake,
          archivedAt: Date.now(),
        };
        await git(o.repo, ['update-ref', REF(o.id), snap.commit]);
        writeFileSync(path.join(work, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
        renameSync(work, folder);
        saved = true;
        o.onPhase?.('removing');
        if (!(await removeFolder(o.repo, o.dir))) return manifest;
        const left: ArchiveManifest = { ...manifest, leftover: true };
        try {
          writeFileSync(path.join(folder, MANIFEST), `${JSON.stringify(left, null, 2)}\n`);
        } catch {
          // The manifest there is good: restore sets a leftover aside all the same.
        }
        return left;
      } catch (err) {
        if (saved) throw err;
        rmSync(work, { recursive: true, force: true });
        // The folder is still there: forget this snapshot (and its manifest) so nothing claims it's archived.
        if (existsSync(o.dir)) {
          rmSync(folder, { recursive: true, force: true });
          await tryGit(o.repo, ['update-ref', '-d', REF(o.id)]);
        }
        throw err;
      }
    }
  });
}

/**
 * Bring an archived worktree back where it was: its branch checked out, every file as it was
 * (staging too), the kept ignored files unpacked. Then the archive goes. A restore that fails
 * takes away what it made and leaves the archive, to try again.
 */
export function restoreWorktree(o: Omit<ArchiveOptions, 'onPhase'>): Promise<ArchiveManifest> {
  return exclusive(o.id, async () => {
    const m = readManifest(o.archivesDir, o.id);
    if (!m) throw new ArchiveError('No archive for this worktree');
    const folder = folderOf(o.archivesDir, o.id);
    if (existsSync(o.dir)) {
      // What an archive couldn't remove (or something put there since): set aside, never deleted.
      const registered = parseWorktreeList(await git(o.repo, ['worktree', 'list', '--porcelain'])).some((w) => w.path === o.dir);
      if (registered) throw new ArchiveError(`${o.dir} is already there`);
      renameSync(o.dir, `${o.dir}.left-${Date.now()}`);
    }
    mkdirSync(path.dirname(o.dir), { recursive: true });
    const tip = m.branch ? await tryGit(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${m.branch}`]) : undefined;
    // The branch is where it was: back on it. Moved on (or gone): at the commit it was on, so nothing of either is mixed up.
    if (m.branch && tip && tip === m.head) await git(o.repo, ['worktree', 'add', o.dir, m.branch], undefined, LONG_MS);
    else if (m.head) await git(o.repo, ['worktree', 'add', '--detach', o.dir, m.head], undefined, LONG_MS);
    else await git(o.repo, ['worktree', 'add', '--orphan', o.dir], undefined, LONG_MS);
    try {
      await git(o.dir, [...RAW_ARGS, 'read-tree', '-u', '--reset', `${m.snapshot}^{tree}`], RAW_ENV, LONG_MS);
      await git(o.dir, ['read-tree', `${m.snapshot}^2^{tree}`], undefined, LONG_MS);
      if (m.keptFile) await unpackKeeping(path.join(folder, m.keptFile), o.dir);
    } catch (err) {
      await tryGit(o.repo, ['worktree', 'remove', '--force', o.dir]);
      rmSync(o.dir, { recursive: true, force: true });
      await tryGit(o.repo, ['worktree', 'prune']);
      throw err;
    }
    await tryGit(o.repo, ['update-ref', '-d', REF(o.id)]);
    rmSync(folder, { recursive: true, force: true });
    return m;
  });
}

const PARTIAL = /^([\w.-]{1,128})\.partial$/;

/**
 * Throw away archives that were cut short (Beluga quit or crashed while compressing): their
 * worktree is still there, untouched, so nothing in them is needed. Left alone, each could be
 * hundreds of MB. Skips one being written now. → how many went.
 */
export async function sweepPartialArchives(archivesDir: string): Promise<number> {
  const names = await readdir(archivesDir).catch(() => [] as string[]);
  const stale = names.filter((name) => {
    const id = PARTIAL.exec(name)?.[1];
    return id !== undefined && !busy.has(id);
  });
  await Promise.all(stale.map((name) => deleteFolderInBackground(path.join(archivesDir, name)).catch(() => undefined)));
  return stale.length;
}

/** Forget an archive (the worktree is deleted for good). */
export async function dropArchive(repo: string, archivesDir: string, id: string): Promise<void> {
  if (repo) await tryGit(repo, ['update-ref', '-d', REF(id)]);
  rmSync(folderOf(archivesDir, id), { recursive: true, force: true });
}

/**
 * Free space in a worktree you keep: throw away only what's made again. Each one is checked
 * again just before it goes: nothing in it tracked or new to git (only ever ignored files).
 */
export async function freeSpace(dir: string): Promise<{ bytes: number; removed: readonly string[]; remake: readonly string[] }> {
  const plan = await planArchive(dir);
  const removed: string[] = [];
  let bytes = 0;
  for (const d of plan.drop) {
    const tracked = await gitLiteral(dir, ['ls-files', '-z', '--', d.path]);
    const fresh = await gitLiteral(dir, ['ls-files', '-z', '--others', '--exclude-standard', '--', d.path]);
    if (tracked || fresh) continue;
    rmSync(path.join(dir, d.path), { recursive: true, force: true });
    removed.push(d.path);
    bytes += d.bytes;
  }
  return { bytes, removed, remake: plan.remake };
}
