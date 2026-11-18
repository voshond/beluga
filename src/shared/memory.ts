/**
 * Beluga's own memory (BLG-95): one about you, one per project, kept under ~/.beluga/memory and
 * added to every own run's instructions on every runtime. Each is capped hard, so agents curate
 * and merge instead of appending forever. Browser-safe: types and numbers only.
 */

export const USER_MEMORY_MAX = 1375;

export const PROJECT_MEMORY_MAX = 2200;

export type MemoryKind = 'user' | 'project';

export type MemoryScope = { readonly kind: 'user' } | { readonly kind: 'project'; readonly root: string };

export type MemoryAuthor = 'you' | 'agent';

export type MemoryEntry = {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly by: MemoryAuthor;
};

export type MemoryView = {
  readonly scope: MemoryScope;
  readonly label: string;
  readonly entries: readonly MemoryEntry[];
  readonly used: number;
  readonly cap: number;
};

export type MemoryOverview = {
  readonly user: MemoryView;
  readonly projects: readonly MemoryView[];
};

export const memoryCap = (scope: MemoryScope): number => (scope.kind === 'user' ? USER_MEMORY_MAX : PROJECT_MEMORY_MAX);

export const memoryUsed = (entries: readonly MemoryEntry[]): number => entries.reduce((sum, e) => sum + e.text.length, 0);

export type MemoryOp = 'add' | 'replace' | 'remove';

/**
 * What one write did (BLG-102): the entry before it (replace, remove) and after it (add, replace),
 * and where it stood. Enough to undo it: an add is removed, a replace restored, a remove put back.
 */
export type MemoryChange = {
  readonly scope: MemoryScope;
  readonly op: MemoryOp;
  readonly before?: MemoryEntry;
  readonly after?: MemoryEntry;
  readonly index: number;
};

/** The entry a change is about: the one written, or the one removed. */
export const changedEntry = (change: MemoryChange): MemoryEntry => (change.after ?? change.before)!;
