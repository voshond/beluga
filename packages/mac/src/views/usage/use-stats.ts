import { useCallback, useEffect, useState } from 'react';
import { EMPTY_STATS, type StatsSnapshot } from '@beluga/shared/stats.js';
import { useApi } from '../../lib/beluga.js';
import { useClock } from '../../lib/window-active.js';

/** While the Usage tab is open: new numbers now and then (the daemon counts anyway; this only asks). */
const REFRESH_MS = 60_000;

export interface GotStats {
  readonly stats: StatsSnapshot | undefined;
  /** When they came: "now" for everything worked out from them, so sums aren't redone with every change in the app. */
  readonly at: number;
  readonly failed?: boolean;
}

/** The daemon's stats (and when they came), asked for when the tab opens and every minute while it's open. */
export function useStats(): GotStats {
  const api = useApi();
  const [got, setGot] = useState<GotStats>(() => ({ stats: undefined, at: Date.now() }));
  const load = useCallback(() => {
    api.stats
      .get()
      .then((s) => setGot({ stats: s as StatsSnapshot, at: Date.now() }))
      .catch(() => setGot((prev) => ({ stats: prev.stats ?? EMPTY_STATS, at: prev.at, failed: !prev.stats })));
  }, [api]);
  // Rests while you look away; asks again the moment you look back.
  const tick = useClock(true, REFRESH_MS);
  useEffect(load, [load, tick]);
  return got;
}

/** A choice remembered in this window between visits. */
export function usePicked<T extends string>(key: string, fallback: T, ok: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      return saved && ok.includes(saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const pick = useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Private mode: remembered until the window closes.
      }
    },
    [key],
  );
  return [v, pick];
}
