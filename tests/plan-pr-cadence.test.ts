import { describe, expect, it } from 'vitest';
import type { PlanPr } from '../src/core/plans/model.js';
import { PLAN_PR_FAST_MS, PLAN_PR_PUSHED_FOR_MS, PLAN_PR_SLOW_MS, planPrCadence } from '../src/core/plans/pr-cadence.js';

/** A plan's PR is looked at often while something on it is about to change, so the page is never long out of date. */

const pr = (over: Partial<PlanPr> = {}): PlanPr => ({ number: 7, url: 'u', state: 'OPEN', title: 'P', draft: false, checks: 'passing', ...over });
const now = 1_000_000;

describe('how often a plan’s pull request is looked at', () => {
  it('often while it conflicts, its checks run, it merges once they pass, or main is being brought in', () => {
    expect(planPrCadence({ branch: 'plan/p', pr: pr({ conflicts: true }) }, undefined, now)).toBe(PLAN_PR_FAST_MS);
    expect(planPrCadence({ branch: 'plan/p', pr: pr({ checks: 'pending' }) }, undefined, now)).toBe(PLAN_PR_FAST_MS);
    expect(planPrCadence({ branch: 'plan/p', pr: pr({ autoMerge: true }) }, undefined, now)).toBe(PLAN_PR_FAST_MS);
    expect(planPrCadence({ branch: 'plan/p', pr: pr(), mainMerge: { at: 1, main: 'origin/main' } }, undefined, now)).toBe(PLAN_PR_FAST_MS);
  });

  it('often for a while after Beluga pushed its branch, then rarely', () => {
    expect(planPrCadence({ branch: 'plan/p', pr: pr() }, now - 1_000, now)).toBe(PLAN_PR_FAST_MS);
    expect(planPrCadence({ branch: 'plan/p', pr: pr() }, now - PLAN_PR_PUSHED_FOR_MS, now)).toBe(PLAN_PR_SLOW_MS);
    expect(planPrCadence({ branch: 'plan/p' }, undefined, now)).toBe(PLAN_PR_SLOW_MS);
  });

  it('never once it’s merged, shipped, or there’s no branch', () => {
    expect(planPrCadence({ branch: 'plan/p', pr: pr({ state: 'MERGED' }) }, undefined, now)).toBeUndefined();
    expect(planPrCadence({ branch: 'plan/p', shipped: { at: 1, how: 'local' } }, undefined, now)).toBeUndefined();
    expect(planPrCadence({}, undefined, now)).toBeUndefined();
  });
});
