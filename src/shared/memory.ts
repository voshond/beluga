/**
 * Beluga's own memory (BLG-95): one about you, one per project, kept under ~/.beluga/memory and
 * added to every own run's instructions on every runtime. Each is capped hard, so agents curate
 * and merge instead of appending forever. Browser-safe: types and numbers only.
 */

export const USER_MEMORY_MAX = 1375;

export const PROJECT_MEMORY_MAX = 2200;

/**
 * BLG-123: filed-away entries live beside the others but stay out of every run: a run gets the ones
 * its request is about (FILED_PER_RUN characters at most), and agents search the rest. Their own cap
 * keeps a memory from growing forever.
 */
export const FILED_MEMORY_MAX = 20_000;

export const FILED_PER_RUN = 800;

export type MemoryKind = 'user' | 'project';

export type MemoryScope = { readonly kind: 'user' } | { readonly kind: 'project'; readonly root: string };

export type MemoryAuthor = 'you' | 'agent';

export type MemoryEntry = {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly by: MemoryAuthor;
  /** BLG-123: filed away: kept beyond the cap, given to a run only when relevant. */
  readonly filed?: boolean;
};

export type MemoryView = {
  readonly scope: MemoryScope;
  readonly label: string;
  readonly entries: readonly MemoryEntry[];
  /** The entries every run gets, against `cap`. */
  readonly used: number;
  readonly cap: number;
  /** BLG-123: the filed-away entries, against `filedCap`. */
  readonly filedUsed: number;
  readonly filedCap: number;
};

export type MemoryOverview = {
  readonly user: MemoryView;
  readonly projects: readonly MemoryView[];
};

export const memoryCap = (scope: MemoryScope): number => (scope.kind === 'user' ? USER_MEMORY_MAX : PROJECT_MEMORY_MAX);

export const filedEntries = (view: Pick<MemoryView, 'entries'>): MemoryEntry[] => view.entries.filter((e) => e.filed);

export const alwaysEntries = (view: Pick<MemoryView, 'entries'>): MemoryEntry[] => view.entries.filter((e) => !e.filed);

export const memoryUsed = (entries: readonly MemoryEntry[]): number => entries.reduce((sum, e) => sum + (e.filed ? 0 : e.text.length), 0);

export const filedUsed = (entries: readonly MemoryEntry[]): number => entries.reduce((sum, e) => sum + (e.filed ? e.text.length : 0), 0);

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'you', 'your', 'they', 'their', 'them', 'its', 'into', 'when', 'what', 'which', 'who', 'how', 'all', 'any', 'can', 'use', 'uses', 'user', 'should', 'would', 'could', 'about', 'there', 'then', 'than', 'also', 'just', 'like', 'lets', 'let', 'please', 'want', 'wants', 'need', 'make']);

/** The words a search matches on: three letters or more, lower case, without the commonest. */
export const searchWords = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)));

/**
 * BLG-123: the entries a query is about, best first: how many of its words each holds (a word matches
 * the start of one in the entry, so "deploy" finds "deploys"), newest first on a tie. None when nothing matches.
 */
export const relevantEntries = (entries: readonly MemoryEntry[], query: string): MemoryEntry[] => {
  const wanted = [...searchWords(query)];
  if (!wanted.length) return [];
  return entries
    .map((entry) => {
      const words = [...searchWords(entry.text)];
      return { entry, score: wanted.filter((w) => words.some((x) => x.startsWith(w) || w.startsWith(x))).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
    .map((s) => s.entry);
};

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

/** What starts a look back (BLG-96): a worktree merging (once, and only with the setting on), or you asking (any time, BLG-108). */
export type ReflectionTrigger = 'merge' | 'manual';

export type ReflectionSkip = 'off' | 'not_yours' | 'short' | 'nothing_new' | 'done' | 'running' | 'full' | 'trouble' | 'empty';

export type ReflectionOutcome = { readonly proposed: number; readonly skill?: 'new' | 'change' } | { readonly skipped: ReflectionSkip; readonly why: string };

/** What a Look Back came to, in one sentence: how many proposals arrived, or why none (BLG-108). */
export const lookBackWords = (outcome: ReflectionOutcome): string => {
  if ('skipped' in outcome) return outcome.why;
  const memories = outcome.proposed - (outcome.skill ? 1 : 0);
  const found = [...(memories ? [`${memories} thing${memories === 1 ? '' : 's'} to remember`] : []), ...(outcome.skill ? [outcome.skill === 'new' ? 'a skill to keep' : 'a fix to a skill'] : [])];
  const words = found.join(' and ');
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}: see Needs You.` : 'Looked back: nothing worth keeping this time.';
};

/** What a Tidy came to (BLG-120): how many merges, forgets and moves wait, or why none. */
export const tidyWords = (outcome: ReflectionOutcome): string => {
  if ('skipped' in outcome) return outcome.why;
  if (!outcome.proposed) return 'Your memory is tidy: nothing to merge, forget, move or file away.';
  return `${outcome.proposed} way${outcome.proposed === 1 ? '' : 's'} to tidy your memory: see Needs You.`;
};
