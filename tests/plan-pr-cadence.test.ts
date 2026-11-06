import { describe, expect, it } from 'vitest';
import { type Plan, type PlanBody, type PlanMilestone, type PlanPr, prRef, shipOrder } from '../src/core/plans/model.js';
import { PLAN_PR_FAST_MS, PLAN_PR_PUSHED_FOR_MS, PLAN_PR_SLOW_MS, planPrCadence, repoPrState } from '../src/core/plans/pr-cadence.js';

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

describe('a plan across repos ships one PR per repo (BLG-16)', () => {
  const ms = (id: string, repos: readonly string[], dependsOn?: readonly string[]): PlanMilestone => ({ id, title: id, criteria: [], tasks: [], repos, ...(dependsOn ? { dependsOn } : {}) });
  const body = (milestones: readonly PlanMilestone[]): PlanBody => ({ title: 'T', goal: 'g', milestones });

  it('merges upstream repos first, by milestone dependencies across repos', () => {
    const plan = { projectId: 'api', repos: ['api', 'cal', 'desk'], body: body([ms('contract', ['cal']), ms('desktop', ['desk'], ['contract']), ms('hooks', ['api'], ['desktop'])]) };
    expect(shipOrder(plan)).toEqual(['cal', 'desk', 'api']);
  });

  it('keeps the plan’s order without dependencies or around a loop, and leaves out repos no milestone touches', () => {
    expect(shipOrder({ projectId: 'api', repos: ['api', 'cal'], body: body([ms('a', ['api']), ms('b', ['cal'])]) })).toEqual(['api', 'cal']);
    expect(shipOrder({ projectId: 'api', repos: ['api', 'cal'], body: body([ms('a', ['api']), ms('b', ['cal'], ['a']), ms('c', ['api'], ['b'])]) })).toEqual(['api', 'cal']);
    expect(shipOrder({ projectId: 'api', repos: ['api', 'cal', 'desk'], body: body([ms('a', ['cal'])]) })).toEqual(['cal']);
    expect(shipOrder({ projectId: 'api' })).toEqual(['api']);
  });

  it('a spanning milestone puts no order between its own repos', () => {
    expect(shipOrder({ projectId: 'api', repos: ['api', 'cal', 'desk'], body: body([ms('base', ['desk']), ms('both', ['cal', 'api'], ['base'])]) })).toEqual(['desk', 'api', 'cal']);
  });

  it('names a PR as owner/repo#N', () => {
    expect(prRef(pr({ number: 12, url: 'https://github.com/bob/calendar-api/pull/12' }))).toBe('bob/calendar-api#12');
    expect(prRef(pr({ number: 3, url: 'u' }))).toBe('#3');
  });

  it('each repo’s PR is looked at on its own: merged in one, still due in another', () => {
    const plan: Pick<Plan, 'projectId' | 'repos' | 'branch' | 'branches' | 'pr' | 'prs' | 'shippedIn' | 'mainMerge'> = { projectId: 'api', repos: ['api', 'cal'], branch: 'plan/p', branches: { api: 'plan/p', cal: 'plan/p' }, pr: pr({ state: 'MERGED' }), prs: { api: pr({ state: 'MERGED' }), cal: pr({ number: 8 }) }, shippedIn: { api: { at: 1, how: 'pr', number: 7 } }, mainMerge: { at: 1, main: 'origin/main', projectId: 'cal' } };
    expect(planPrCadence(repoPrState(plan, 'api'), undefined, now)).toBeUndefined();
    expect(repoPrState(plan, 'cal')).toMatchObject({ branch: 'plan/p', pr: { number: 8 }, mainMerge: { projectId: 'cal' } });
    expect(planPrCadence(repoPrState(plan, 'cal'), undefined, now)).toBe(PLAN_PR_FAST_MS);
  });
});
