import { useSyncExternalStore } from 'react';
import type { BranchStep } from '@beluga/core/branch-state.js';

/** A way to create a pull request, from Create PR's chevron. */
export type PrWay = 'pr' | 'pr_claude' | 'pr_custom' | 'pr_draft' | 'pr_original';

const PR_WAYS: readonly PrWay[] = ['pr', 'pr_claude', 'pr_custom', 'pr_draft', 'pr_original'];
const KEY = 'beluga.prWay';
const listeners = new Set<() => void>();

export const isPrWay = (id: string): id is PrWay => PR_WAYS.includes(id as PrWay);

/** The way you last created a pull request (plain Create PR until you pick another). */
export function lastPrWay(): PrWay {
  try {
    const way = localStorage.getItem(KEY);
    return way && isPrWay(way) ? way : 'pr';
  } catch {
    return 'pr';
  }
}

export function rememberPrWay(way: PrWay): void {
  try {
    localStorage.setItem(KEY, way);
  } catch {
    // No storage: plain Create PR next time.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The remembered way, the same in the toolbar and the Changes tab. */
export const usePrWay = (): PrWay => useSyncExternalStore(subscribe, lastPrWay);

/** When Create PR leads, the way you last picked takes its place, and Create PR moves into the menu. */
export function withPrWayFirst(steps: readonly BranchStep[], way: PrWay): readonly BranchStep[] {
  if (steps[0]?.id !== 'pr' || way === 'pr') return steps;
  const picked = steps.find((step) => step.id === way);
  return picked ? [picked, ...steps.filter((step) => step !== picked)] : steps;
}
