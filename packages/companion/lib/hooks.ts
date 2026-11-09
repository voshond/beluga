import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NeedsYou, OutputView, Topic } from './link/protocol';
import { kv } from './kv';
import type { ComputerLinkState } from './link/computers';
import { mergeNeeds } from './link/needs';
import { useOn } from './scope';
import { type CachedView, type FileState, type LinkState, type OutboxItem, store, type Toast } from './store';

/** The screens' way into the store. Each hook re-renders only when its own key changes. */

export function useLink(): LinkState {
  return useSyncExternalStore(
    (fn) => store.subscribe('state', fn),
    () => store.getState(),
  );
}

/** Does the Mac (or the computer this screen shows) have this, by its protocol's minor? Re-renders when the link learns it. */
export function useSupports(what: Parameters<typeof store.supports>[0]): boolean {
  const on = useOn();
  useLink();
  useComputers();
  return on ? store.supportsOn(on, what) : store.supports(what);
}

/** A topic's view; subscribes to it on the Mac (or the computer this screen shows) while the screen is mounted. */
export function useView<T>(topic: Topic | undefined): CachedView<T> | undefined {
  return useViewAt<T>(useOn(), topic);
}

/** A topic's view on your Mac (`on` undefined) or on one of your computers, whatever scope the screen is in. */
export function useViewAt<T>(on: string | undefined, topic: Topic | undefined): CachedView<T> | undefined {
  useEffect(() => (topic ? (on ? store.watchOn(on, topic) : store.watch(topic)) : undefined), [topic, on]);
  const key = topic ? (on ? `view:${on}|${topic}` : `view:${topic}`) : undefined;
  return useSyncExternalStore(
    (fn) => (key ? store.subscribe(key, fn) : () => {}),
    () => (topic ? (on ? store.viewOn<T>(on, topic) : store.view<T>(topic)) : undefined),
  );
}

/** Your computers and how each link is (BLG-809). */
export function useComputers(): readonly ComputerLinkState[] {
  return useSyncExternalStore(
    (fn) => store.subscribe('computers', fn),
    () => store.computers(),
  );
}

/** One of your computers, by id. */
export function useComputer(id: string | undefined): ComputerLinkState | undefined {
  return useComputers().find((c) => c.computer.id === id);
}

/**
 * What needs you on your Mac and on every computer of yours (BLG-810): each computer's home is
 * followed on its own link while this is shown, its items say which computer, and answering one
 * goes back to it.
 */
export function useAllNeeds(mac: readonly NeedsYou[] | undefined): NeedsYou[] {
  const computers = useComputers();
  const ids = computers.map((c) => c.computer.id).join(',');
  useEffect(() => {
    const offs = ids ? ids.split(',').map((id) => store.watchOn(id, 'home')) : [];
    return () => offs.forEach((off) => off());
  }, [ids]);
  const theirs = useSyncExternalStore(
    (fn) => store.subscribe('computer-needs', fn),
    () => store.computerNeeds(),
  );
  // Each thing once: the Mac's copy while its link is open, else your Always On's, where an answer is taken now (BLG-857).
  const macOpen = useLink().phase === 'open';
  return useVisibleNeeds(theirs.length ? mergeNeeds(mac, theirs, macOpen) : mac);
}

/** Needs-you items minus the ones you've just answered (until the Mac drops them). */
export function useVisibleNeeds(items: readonly NeedsYou[] | undefined): NeedsYou[] {
  useSyncExternalStore(
    (fn) => store.subscribe('hidden', fn),
    () => store.snapshot('hidden', () => ({})),
  );
  return (items ?? []).filter((n) => !store.isHidden(n.id));
}

export function useFile(ref: string | undefined, variant: 'thumb' | 'full' | 'text'): FileState | undefined {
  const key = `${ref}#${variant}`;
  // A computer's files aren't fetched through your Mac (their refs are that computer's own, BLG-810).
  const on = useOn();
  const name = useComputer(on)?.computer.name;
  useEffect(() => {
    if (ref && !on) store.fetch(ref, variant);
  }, [ref, variant, on]);
  const state = useSyncExternalStore(
    (fn) => (ref && !on ? store.subscribe(`file:${key}`, fn) : () => {}),
    () => (ref && !on ? store.file(ref, variant) : undefined),
  );
  return on && ref ? { status: 'error', got: 0, error: `Opens on ${name ?? 'that computer'}` } : state;
}

/** How saving an output on the phone goes (lib/saved.ts): only watched, never started here. */
export function useSaving(ref: string | undefined): FileState | undefined {
  const key = `${ref}#save`;
  return useSyncExternalStore(
    (fn) => (ref ? store.subscribe(`file:${key}`, fn) : () => {}),
    () => (ref ? store.file(ref, 'save') : undefined),
  );
}

/** The newest we know of an output (a growing log's size). */
export function useOutput(ref: string | undefined): OutputView | undefined {
  return useSyncExternalStore(
    (fn) => (ref ? store.subscribe(`out:${ref}`, fn) : () => {}),
    () => store.snapshot(`out:${ref}`, () => (ref ? store.output(ref) : undefined)),
  );
}

/** A project's icon (a data: URI) by its checksum: fetched once, then from the cache. */
export function useIcon(sum: string | undefined): string | undefined {
  const phase = useSyncExternalStore(
    (fn) => store.subscribe('state', fn),
    () => store.getState().phase,
  );
  useEffect(() => void store.icon(sum), [sum, phase]);
  return useSyncExternalStore(
    (fn) => (sum ? store.subscribe(`icon:${sum}`, fn) : () => {}),
    () => store.cachedIcon(sum),
  );
}

/** Seconds since `ts`, ticking once a second while shown (the phone counts; nothing streams). */
export function useSince(ts: number | undefined): number | undefined {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (ts === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ts]);
  return ts === undefined ? undefined : Math.max(0, Math.round((now - ts) / 1000));
}

/** "42s", "3m 05s", "1h 02m". */
export const elapsed = (s: number | undefined): string => {
  if (s === undefined) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export function useOutbox(): OutboxItem[] {
  return useSyncExternalStore(
    (fn) => store.subscribe('outbox', fn),
    () => store.getOutbox(),
  );
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => store.subscribe('toasts', fn),
    () => store.getToasts(),
  );
}

/** "as of 10:42" for a view that didn't come from the Mac this session. */
export const asOf = (at: number): string => `as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function until(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const m = Math.max(0, Math.round((ts - now) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/**
 * Which groups of a list are folded (Work's projects, Tasks' projects): kept between launches,
 * per list. `folded(id)` and `toggle(id)`; a group nobody folded is open.
 */
export function useFolded(list: string): { readonly folded: (id: string) => boolean; readonly toggle: (id: string) => void } {
  const key = `folded:${list}`;
  const [ids, setIds] = useState<readonly string[]>(() => kv.get<string[]>(key) ?? []);
  return {
    folded: (id) => ids.includes(id),
    toggle: (id) =>
      setIds((was) => {
        const next = was.includes(id) ? was.filter((x) => x !== id) : [...was, id];
        kv.set(key, next);
        return next;
      }),
  };
}
