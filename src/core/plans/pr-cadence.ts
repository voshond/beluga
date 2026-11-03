import type { Plan } from './model.js';

/**
 * How often a plan's pull request is looked at on GitHub: often while something on it is about to
 * change (just pushed, a conflict being solved, checks running, merging once they pass), so the
 * page says "conflicts with main" no longer than a few seconds after it isn't; rarely otherwise.
 * Pure (tests/plan-pr-cadence.test.ts).
 */

/** Nothing about to change on it. */
export const PLAN_PR_SLOW_MS = 2 * 60_000;
/** Something about to change on it. */
export const PLAN_PR_FAST_MS = 15_000;
/** After Beluga pushes the plan's branch, looked at fast this long (GitHub works out conflicts and checks a little after a push). */
export const PLAN_PR_PUSHED_FOR_MS = 2 * 60_000;
/** You came back to the window: a PR not looked at in this long is looked at now. */
export const PLAN_PR_FOCUS_FRESH_MS = 5_000;

/** How long until a plan's PR is looked at again (undefined: never, it's merged or there's nothing to ship). */
export function planPrCadence(plan: Pick<Plan, 'branch' | 'shipped' | 'pr' | 'mainMerge'>, pushedAt: number | undefined, now: number): number | undefined {
  if (!plan.branch || plan.shipped || plan.pr?.state === 'MERGED') return undefined;
  if (pushedAt !== undefined && now - pushedAt < PLAN_PR_PUSHED_FOR_MS) return PLAN_PR_FAST_MS;
  const pr = plan.pr;
  if (plan.mainMerge || (pr?.state === 'OPEN' && (pr.conflicts || pr.checks === 'pending' || pr.autoMerge))) return PLAN_PR_FAST_MS;
  return PLAN_PR_SLOW_MS;
}
