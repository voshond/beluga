import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FILED_MEMORY_MAX, type MemoryAuthor, type MemoryChange, type MemoryEntry, type MemoryScope, type MemoryView, filedUsed, memoryCap, memoryUsed } from '../../shared/memory.js';
import { secretIn } from '../../shared/secret-text.js';
import { writeJson } from '../../workspaces/store.js';
import { belugaHome } from '../home.js';

/**
 * Beluga's memory on disk (BLG-95): ~/.beluga/memory/user.json and one file per project under
 * ~/.beluga/memory/projects/, written atomically and 0600. Every write checks the cap and refuses
 * anything that looks like a secret. The reflection pass (BLG-96) and team memory (BLG-100) build on it.
 */

type MemoryFile = {
  readonly root?: string;
  readonly entries: readonly MemoryEntry[];
};

export class MemoryError extends Error {}

/** One write: the text for an add, the entry (id or a piece of its text) for a replace or remove; `file` files an entry away or brings it back (BLG-123). */
export type MemoryWriteOp =
  | { readonly op: 'add'; readonly text: string; readonly filed?: boolean }
  | { readonly op: 'replace'; readonly entry: string; readonly text: string }
  | { readonly op: 'remove'; readonly entry: string }
  | { readonly op: 'file'; readonly entry: string; readonly filed: boolean };

/** The memory after a write, and what the write changed (BLG-102: what Undo needs). */
export type MemoryWrite = { readonly view: MemoryView; readonly change: MemoryChange };

const SECRET_WORDS = /\b(password|passwd|passphrase|api[ _-]?key|secret|token|bearer)\s*[:=]\s*\S{4,}/i;

const scopeName = (scope: MemoryScope): string => (scope.kind === 'user' ? 'Memory about the user' : 'This project’s memory');

const cleanText = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

const newId = (): string => randomBytes(3).toString('hex');

export const projectKey = (root: string): string => createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);

export const secretInMemory = (text: string): string | undefined => secretIn(text) ?? (SECRET_WORDS.test(text) ? 'a password or token' : undefined);

const checkText = (text: string): string => {
  const clean = cleanText(text);
  if (!clean) throw new MemoryError('An entry needs some text.');
  const secret = secretInMemory(clean);
  if (secret) throw new MemoryError(`That looks like ${secret}. Secrets never go into memory: say where access is, not what it is.`);
  return clean;
};

const checkCap = (scope: MemoryScope, before: readonly MemoryEntry[], after: readonly MemoryEntry[]): void => {
  const cap = memoryCap(scope);
  const used = memoryUsed(after);
  if (used > cap && used > memoryUsed(before))
    throw new MemoryError(
      `${scopeName(scope)} is full: this would use ${used} of ${cap} characters. Merge related entries into one with memory_replace, drop stale ones with memory_remove, or file away what only matters sometimes with memory_file, then try again.`,
    );
  const filed = filedUsed(after);
  if (filed > FILED_MEMORY_MAX && filed > filedUsed(before)) throw new MemoryError(`${scopeName(scope)} has no room left to file away: this would use ${filed} of ${FILED_MEMORY_MAX} characters. Forget stale filed entries first.`);
};

const sameEntry = (a: MemoryEntry | undefined, b: MemoryEntry | undefined): boolean => Boolean(a && b && a.id === b.id && a.text === b.text && a.at === b.at);

const findEntry = (entries: readonly MemoryEntry[], ref: string): MemoryEntry => {
  const exact = entries.find((e) => e.id === ref.trim());
  if (exact) return exact;
  const want = cleanText(ref).toLowerCase();
  const matches = want ? entries.filter((e) => e.text.toLowerCase().includes(want)) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new MemoryError(`"${ref}" matches ${matches.length} entries: give the entry's id.`);
  throw new MemoryError(`No entry "${ref}". Give an entry's id as memory_list shows it.`);
};

export class MemoryStore {
  constructor(private readonly home: string = belugaHome()) {}

  private get dir(): string {
    return path.join(this.home, 'memory');
  }

  private fileOf(scope: MemoryScope): string {
    return scope.kind === 'user' ? path.join(this.dir, 'user.json') : path.join(this.dir, 'projects', `${projectKey(scope.root)}.json`);
  }

  private load(file: string): MemoryFile {
    if (!existsSync(file)) return { entries: [] };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<MemoryFile>;
      return { ...(typeof raw.root === 'string' ? { root: raw.root } : {}), entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => typeof e?.id === 'string' && typeof e.text === 'string') : [] };
    } catch {
      try {
        copyFileSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        return { entries: [] };
      }
      return { entries: [] };
    }
  }

  private save(scope: MemoryScope, before: readonly MemoryEntry[], entries: readonly MemoryEntry[]): MemoryView {
    checkCap(scope, before, entries);
    writeJson(this.fileOf(scope), { ...(scope.kind === 'project' ? { root: path.resolve(scope.root) } : {}), entries });
    return this.read(scope);
  }

  read(scope: MemoryScope, label?: string): MemoryView {
    const { entries } = this.load(this.fileOf(scope));
    return { scope, label: label ?? (scope.kind === 'user' ? 'About you' : path.basename(scope.root)), entries, used: memoryUsed(entries), cap: memoryCap(scope), filedUsed: filedUsed(entries), filedCap: FILED_MEMORY_MAX };
  }

  add(scope: MemoryScope, text: string, by: MemoryAuthor): MemoryView {
    return this.write(scope, { op: 'add', text }, by).view;
  }

  replace(scope: MemoryScope, ref: string, text: string, by: MemoryAuthor): MemoryView {
    return this.write(scope, { op: 'replace', entry: ref, text }, by).view;
  }

  remove(scope: MemoryScope, ref: string): MemoryView {
    return this.write(scope, { op: 'remove', entry: ref }, 'you').view;
  }

  /** Add, replace or remove one entry, and say what changed (the entry before and after, and where it stood). */
  write(scope: MemoryScope, op: MemoryWriteOp, by: MemoryAuthor): MemoryWrite {
    const { entries } = this.load(this.fileOf(scope));
    if (op.op === 'add') {
      const clean = checkText(op.text);
      if (entries.some((e) => e.text.toLowerCase() === clean.toLowerCase())) throw new MemoryError('That is remembered already.');
      const after: MemoryEntry = { id: newId(), text: clean, at: Date.now(), by, ...(op.filed ? { filed: true } : {}) };
      return { view: this.save(scope, entries, [...entries, after]), change: { scope, op: 'add', after, index: entries.length } };
    }
    if (op.op === 'file') {
      const before = findEntry(entries, op.entry);
      if (Boolean(before.filed) === op.filed) throw new MemoryError(op.filed ? 'That entry is filed away already.' : 'Every run gets that entry already.');
      const { filed: _, ...rest } = before;
      const after: MemoryEntry = { ...rest, at: Date.now(), by, ...(op.filed ? { filed: true } : {}) };
      return { view: this.save(scope, entries, entries.map((e) => (e.id === before.id ? after : e))), change: { scope, op: 'replace', before, after, index: entries.indexOf(before) } };
    }
    if (op.op === 'replace') {
      const clean = checkText(op.text);
      const before = findEntry(entries, op.entry);
      const after: MemoryEntry = { ...before, text: clean, at: Date.now(), by };
      return { view: this.save(scope, entries, entries.map((e) => (e.id === before.id ? after : e))), change: { scope, op: 'replace', before, after, index: entries.indexOf(before) } };
    }
    const before = findEntry(entries, op.entry);
    return { view: this.save(scope, entries, entries.filter((e) => e.id !== before.id)), change: { scope, op: 'remove', before, index: entries.indexOf(before) } };
  }

  /** BLG-120: rewrite `keep` and remove the `fold` entries, as one write: it fits whenever the result is no bigger. */
  merge(scope: MemoryScope, keep: string, fold: readonly string[], text: string, by: MemoryAuthor): MemoryView {
    const { entries } = this.load(this.fileOf(scope));
    const clean = checkText(text);
    const kept = findEntry(entries, keep);
    const gone = new Set(fold.map((ref) => findEntry(entries, ref).id).filter((id) => id !== kept.id));
    const after = entries.filter((e) => !gone.has(e.id)).map((e) => (e.id === kept.id ? { ...e, text: clean, at: Date.now(), by } : e));
    return this.save(scope, entries, after);
  }

  /** BLG-121: move an entry to another memory (its text may change on the way); the target is put back when the source can't be written. */
  move(from: MemoryScope, to: MemoryScope, ref: string, text: string, by: MemoryAuthor): MemoryView {
    const source = this.load(this.fileOf(from)).entries;
    const entry = findEntry(source, ref);
    const target = this.load(this.fileOf(to)).entries;
    const clean = checkText(text);
    const known = target.some((e) => e.text.toLowerCase() === clean.toLowerCase());
    const view = known ? this.read(to) : this.save(to, target, [...target, { id: newId(), text: clean, at: Date.now(), by, ...(entry.filed ? { filed: true } : {}) }]);
    try {
      this.save(from, source, source.filter((e) => e.id !== entry.id));
    } catch (err) {
      if (!known) writeJson(this.fileOf(to), { ...(to.kind === 'project' ? { root: path.resolve(to.root) } : {}), entries: target });
      throw err;
    }
    return view;
  }

  /**
   * Undo one write (BLG-102): an add is removed, a replace restored, a remove put back where it was.
   * Refused, with nothing changed, when the entry changed again since (or the undo was done already),
   * or when putting it back would take the memory over its cap.
   */
  undo(change: MemoryChange): MemoryView {
    const { scope } = change;
    const { entries } = this.load(this.fileOf(scope));
    const id = (change.after ?? change.before)!.id;
    const now = entries.find((e) => e.id === id);
    if (change.op === 'remove') {
      if (now) throw new MemoryError('That entry is back already.');
      const before = change.before!;
      if (entries.some((e) => e.text.toLowerCase() === before.text.toLowerCase())) throw new MemoryError('That is remembered again already.');
      return this.restore(scope, entries, [...entries.slice(0, change.index), before, ...entries.slice(change.index)]);
    }
    if (!now) throw new MemoryError(change.op === 'add' ? 'That entry is gone already.' : 'That entry was removed since: nothing to restore.');
    if (!sameEntry(now, change.after)) throw new MemoryError('That entry changed since: change it in Settings instead.');
    if (change.op === 'add') return this.restore(scope, entries, entries.filter((e) => e.id !== id));
    return this.restore(scope, entries, entries.map((e) => (e.id === id ? change.before! : e)));
  }

  private restore(scope: MemoryScope, before: readonly MemoryEntry[], after: readonly MemoryEntry[]): MemoryView {
    const used = memoryUsed(after);
    const cap = memoryCap(scope);
    if (used > cap && used > memoryUsed(before)) throw new MemoryError(`${scopeName(scope)} is full: putting it back would use ${used} of ${cap} characters. Make room first, then undo again.`);
    const filed = filedUsed(after);
    if (filed > FILED_MEMORY_MAX && filed > filedUsed(before)) throw new MemoryError(`${scopeName(scope)} has no room left to file away: putting it back would use ${filed} of ${FILED_MEMORY_MAX} characters.`);
    return this.save(scope, before, after);
  }

  projectRoots(): string[] {
    const folder = path.join(this.dir, 'projects');
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => this.load(path.join(folder, name)).root ?? []);
  }
}
