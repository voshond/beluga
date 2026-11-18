import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { type MemoryAuthor, type MemoryEntry, type MemoryScope, type MemoryView, memoryCap, memoryUsed } from '../../shared/memory.js';
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
  if (used <= cap || used <= memoryUsed(before)) return;
  throw new MemoryError(`${scopeName(scope)} is full: this would use ${used} of ${cap} characters. Merge related entries into one with memory_replace, or drop stale ones with memory_remove, then try again.`);
};

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
    return { scope, label: label ?? (scope.kind === 'user' ? 'About you' : path.basename(scope.root)), entries, used: memoryUsed(entries), cap: memoryCap(scope) };
  }

  add(scope: MemoryScope, text: string, by: MemoryAuthor): MemoryView {
    const clean = checkText(text);
    const { entries } = this.load(this.fileOf(scope));
    if (entries.some((e) => e.text.toLowerCase() === clean.toLowerCase())) throw new MemoryError('That is remembered already.');
    return this.save(scope, entries, [...entries, { id: newId(), text: clean, at: Date.now(), by }]);
  }

  replace(scope: MemoryScope, ref: string, text: string, by: MemoryAuthor): MemoryView {
    const clean = checkText(text);
    const { entries } = this.load(this.fileOf(scope));
    const target = findEntry(entries, ref);
    return this.save(scope, entries, entries.map((e) => (e.id === target.id ? { ...e, text: clean, at: Date.now(), by } : e)));
  }

  remove(scope: MemoryScope, ref: string): MemoryView {
    const { entries } = this.load(this.fileOf(scope));
    const target = findEntry(entries, ref);
    return this.save(scope, entries, entries.filter((e) => e.id !== target.id));
  }

  projectRoots(): string[] {
    const folder = path.join(this.dir, 'projects');
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => this.load(path.join(folder, name)).root ?? []);
  }
}
