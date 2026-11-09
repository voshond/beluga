import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepRecord, StepSummary } from '@beluga/shared/steps.js';
import { useApi, useScopedKey } from '../../lib/beluga.js';
import { useWindowActive } from '../../lib/window-active.js';
import { beat, usePowerSaving } from '../../lib/power.js';

interface Loaded {
  readonly key: string;
  readonly version?: number | undefined;
  readonly steps?: readonly StepSummary[];
  readonly missing: boolean;
}

/** Cards seen lately, as last read: a card drawn anew (a turn split in two, BLG-22) starts with its steps, not without them. */
const seen = new Map<string, Loaded>();
const SEEN_MAX = 200;
function remember(loaded: Loaded): void {
  seen.delete(loaded.key);
  seen.set(loaded.key, loaded);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
}

/**
 * A Claude card's steps in detail (`agent.steps`): fetched when the card shows, then every
 * second while Claude works and you're looking at Beluga (only what changed comes back), right
 * away when you look back, and once more when it ends.
 * `undefined` steps: not loaded yet, or this computer has no details (someone else's Claude).
 */
export function useAgentSteps(channel: string, itemId: string, running: boolean, change: string, enabled = true): { steps: readonly StepSummary[] | undefined; missing: boolean } {
  const api = useApi();
  // A card's steps as its computer has them (BLG-784).
  const key = useScopedKey(`${channel}/${itemId}`);
  const [state, setState] = useState<Loaded>(() => seen.get(key) ?? { key: '', missing: false });
  const version = useRef<number | undefined>(seen.get(key)?.version);
  const busy = useRef(false);
  const again = useRef(false);
  const looking = useWindowActive();

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    // One at a time; a change while one is out asks once more after it.
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const page = await api.agent.steps(channel, itemId, version.current);
      if (page.unchanged) return;
      version.current = page.version;
      const loaded: Loaded = { key, version: page.version, missing: Boolean(page.missing), ...(page.missing ? {} : { steps: page.steps }) };
      remember(loaded);
      setState(loaded);
    } catch {
      // The daemon went away for a moment: the next tick tries again.
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [api, channel, itemId, key, enabled]);

  const shown = useRef(key);
  useEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    const known = seen.get(key);
    version.current = known?.version;
    setState(known ?? { key, missing: false });
  }, [key]);

  // When the card changes (a new step line, a status), when Claude stops, and when you look back.
  useEffect(() => {
    if (looking) void load();
  }, [load, change, running, looking]);

  const every = beat(1000, usePowerSaving());
  useEffect(() => {
    if (!running || !enabled || !looking) return;
    const t = setInterval(() => void load(), every);
    return () => clearInterval(t);
  }, [load, running, enabled, looking, every]);

  return state.key === key ? { steps: state.steps, missing: state.missing } : { steps: undefined, missing: false };
}

/**
 * One step's details, fetched when it's opened (and again while it's still running, so its
 * output shows when it arrives). `load` reads it from wherever the step lives.
 */
export function useStepDetail(load: () => Promise<StepRecord | undefined>, open: boolean, change: string): { record?: StepRecord; loading: boolean; gone: boolean } {
  const [state, setState] = useState<{ record?: StepRecord; loading: boolean; gone: boolean }>({ loading: false, gone: false });
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState((prev) => ({ ...prev, loading: !prev.record }));
    loader
      .current()
      .then((record) => alive && setState(record ? { record, loading: false, gone: false } : { loading: false, gone: true }))
      .catch(() => alive && setState((prev) => ({ ...prev, loading: false, gone: !prev.record })));
    return () => {
      alive = false;
    };
  }, [open, change]);
  return state;
}
