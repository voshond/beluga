// Relative, not @beluga/shared: the root's tests read this file too.
import type { Field } from '../../../../../src/shared/preview/shape.js';

/**
 * The props you changed in a preview, kept in the window's own storage so they're still there
 * when you scroll back or open Beluga again (per worktree and preview). Only what you changed is
 * kept; the newest MAX_KEPT previews' worth, the oldest let go.
 */

export interface Kept {
  readonly values: Readonly<Record<string, unknown>>;
  /** The props you set or cleared (the rest follow the component). */
  readonly touched: readonly string[];
}

const PREFIX = 'beluga.preview.v1:';
const INDEX = 'beluga.preview.v1';
export const MAX_KEPT = 100;
/** A preview's kept props, at most (a big list is still kept, a huge one isn't). */
const MAX_BYTES = 64 * 1024;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): Store | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

/** One preview's key: its worktree and what it draws. */
export const keptKey = (wsId: string, spec: unknown): string => `${wsId}\u0000${JSON.stringify(spec)}`;

function index(store: Store): string[] {
  try {
    const list: unknown = JSON.parse(store.getItem(INDEX) ?? '[]');
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function readKept(key: string, store: Store | undefined = storage()): Kept | undefined {
  try {
    const raw = store?.getItem(PREFIX + key);
    if (!raw) return undefined;
    const kept = JSON.parse(raw) as Kept;
    return kept && typeof kept.values === 'object' && Array.isArray(kept.touched) ? kept : undefined;
  } catch {
    return undefined;
  }
}

/** Keep what you changed (only those props); nothing changed: forgotten. */
export function writeKept(key: string, values: Readonly<Record<string, unknown>>, touched: ReadonlySet<string>, store: Store | undefined = storage()): void {
  if (!store) return;
  try {
    const list = index(store).filter((k) => k !== key);
    if (!touched.size) {
      store.removeItem(PREFIX + key);
      store.setItem(INDEX, JSON.stringify(list));
      return;
    }
    const mine = Object.fromEntries([...touched].filter((n) => n in values).map((n) => [n, values[n]]));
    const text = JSON.stringify({ values: mine, touched: [...touched] } satisfies Kept);
    if (text.length > MAX_BYTES) return;
    store.setItem(PREFIX + key, text);
    list.push(key);
    for (const old of list.splice(0, Math.max(0, list.length - MAX_KEPT))) store.removeItem(PREFIX + old);
    store.setItem(INDEX, JSON.stringify(list));
  } catch {
    /* full or unavailable: nothing kept */
  }
}

/** Kept props laid over the ones a preview starts with, for the props it still has. */
export function withKept(fields: readonly Field[], fresh: Readonly<Record<string, unknown>>, kept: Kept | undefined): { values: Record<string, unknown>; touched: Set<string> } {
  const names = new Set(fields.map((f) => f.name));
  const values: Record<string, unknown> = { ...fresh };
  const touched = new Set<string>();
  for (const name of kept?.touched ?? []) {
    if (!names.has(name)) continue;
    touched.add(name);
    if (kept && name in kept.values) values[name] = kept.values[name];
    else delete values[name];
  }
  return { values, touched };
}
