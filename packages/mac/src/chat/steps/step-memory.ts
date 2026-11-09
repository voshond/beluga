import { useCallback, useSyncExternalStore } from 'react';
import { useScopedKey } from '../../lib/beluga.js';

/**
 * Which steps you opened, per card, for as long as the window is open: scrolling a card out of
 * the (virtualized) chat and back, or switching conversations, keeps them as you left them.
 * Everything showing one card (its steps, its Expand all) shares it.
 */
interface Memory {
  /** Expand all: every step open except those in `ids`; otherwise only those in `ids`. */
  readonly all: boolean;
  readonly ids: ReadonlySet<string>;
  /** A finished card's steps, folded away once Claude answered, shown again on request. */
  readonly shown?: boolean;
}

const EMPTY: Memory = { all: false, ids: new Set() };
const memory = new Map<string, Memory>();
const listeners = new Map<string, Set<() => void>>();

function set(scope: string, next: Memory): void {
  memory.set(scope, next);
  for (const l of listeners.get(scope) ?? []) l();
}

export interface Disclosure {
  readonly isOpen: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  /** Open every step (and show the folded ones), or close them all. */
  readonly setAllOpen: (open: boolean) => void;
  /** Expand all is on. */
  readonly all: boolean;
  /** Anything open. */
  readonly any: boolean;
  /** A finished card's folded steps are showing (Show Steps). */
  readonly shown: boolean;
  readonly setShown: (shown: boolean) => void;
}

export function useDisclosure(card: string): Disclosure {
  // Each computer's cards their own (BLG-784).
  const scope = useScopedKey(card);
  const m = useSyncExternalStore(
    useCallback(
      (l: () => void) => {
        const ls = listeners.get(scope) ?? new Set();
        ls.add(l);
        listeners.set(scope, ls);
        return () => ls.delete(l);
      },
      [scope],
    ),
    () => memory.get(scope) ?? EMPTY,
  );
  const toggle = useCallback(
    (id: string): void => {
      const cur = memory.get(scope) ?? EMPTY;
      const ids = new Set(cur.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      set(scope, { ...cur, ids });
    },
    [scope],
  );
  const setAllOpen = useCallback((open: boolean): void => set(scope, { ...(memory.get(scope) ?? EMPTY), all: open, ids: new Set() }), [scope]);
  const setShown = useCallback((shown: boolean): void => set(scope, { ...(memory.get(scope) ?? EMPTY), shown }), [scope]);
  const isOpen = (id: string): boolean => (m.all ? !m.ids.has(id) : m.ids.has(id));
  return { isOpen, toggle, setAllOpen, all: m.all, any: m.all || m.ids.size > 0, shown: Boolean(m.shown), setShown };
}
