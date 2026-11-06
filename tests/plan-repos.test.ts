import { describe, expect, it } from 'vitest';
import { PlanError, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { diffBodies, isMultiRepo, milestoneRepos, planRepos } from '../src/core/plans/model.js';

const oldPlan = { projectId: 'p_api' };
const multi = { projectId: 'p_api', repos: ['p_api', 'p_cal', 'p_desk'] };

const body = (repos?: readonly string[]) =>
  normalizeBody(
    {
      title: 'Cross-repo feature',
      goal: 'Ship it everywhere',
      milestones: [
        { id: 'contract', title: 'API contract', ...(repos ? { repos } : {}), tasks: [{ id: 't1', title: 'Define it' }] },
        { id: 'client', title: 'Client', tasks: [{ id: 't2', title: 'Use it' }] },
      ],
    },
    [],
    planRepos(multi),
  );

describe('plan repos', () => {
  it('an old plan has only its projectId', () => {
    expect(planRepos(oldPlan)).toEqual(['p_api']);
    expect(isMultiRepo(oldPlan)).toBe(false);
    expect(milestoneRepos(oldPlan, { repos: undefined })).toEqual(['p_api']);
    expect(milestoneRepos(oldPlan, undefined)).toEqual(['p_api']);
  });

  it('a multi-repo plan lists the primary first, once', () => {
    expect(planRepos({ projectId: 'p_cal', repos: ['p_api', 'p_cal'] })).toEqual(['p_cal', 'p_api']);
    expect(isMultiRepo(multi)).toBe(true);
  });

  it('a milestone runs in its repos, else the primary', () => {
    expect(milestoneRepos(multi, { repos: ['p_desk'] })).toEqual(['p_desk']);
    expect(milestoneRepos(multi, { repos: ['p_cal', 'p_desk'] })).toEqual(['p_cal', 'p_desk']);
    expect(milestoneRepos(multi, { repos: [] })).toEqual(['p_api']);
    expect(milestoneRepos(multi, { repos: ['p_gone'] })).toEqual(['p_api']);
  });

  it('drafts keep milestone repos, and leave them out when not given', () => {
    const b = body(['p_cal', ' p_cal ', 'p_desk']);
    expect(b.milestones[0]!.repos).toEqual(['p_cal', 'p_desk']);
    expect('repos' in b.milestones[1]!).toBe(false);
    expect('repos' in body().milestones[0]!).toBe(false);
  });

  it('refuses a milestone naming a repo outside the plan, in plain words', () => {
    expect(() => body(['p_cal', 'p_other'])).toThrow(PlanError);
    expect(() => body(['p_other'])).toThrow(/Milestone "contract" works in "p_other", which isn't one of this plan's repos \(repos: p_api, p_cal, p_desk\)/);
    expect(() => normalizeBody({ title: 'Solo', goal: '', milestones: [{ title: 'M', repos: ['p_cal'] }] }, [], planRepos(oldPlan))).toThrow(/isn't one of this plan's repos/);
  });

  it('update_milestone sets, keeps and clears repos, and is checked', () => {
    const b = body();
    const set = applyOps(b, [{ op: 'update_milestone', id: 'client', repos: ['p_desk'] }], planRepos(multi));
    expect(set.milestones[1]!.repos).toEqual(['p_desk']);
    expect(applyOps(set, [{ op: 'update_milestone', id: 'client', title: 'Desktop client' }], planRepos(multi)).milestones[1]!.repos).toEqual(['p_desk']);
    expect('repos' in applyOps(set, [{ op: 'update_milestone', id: 'client', repos: null }], planRepos(multi)).milestones[1]!).toBe(false);
    expect(() => applyOps(b, [{ op: 'update_milestone', id: 'client', repos: ['p_x'] }], planRepos(multi))).toThrow(/isn't one of this plan's repos/);
    expect(diffBodies(b, set).milestones).toBeGreaterThan(0);
  });

  it('old plans without repos still normalize and edit as before', () => {
    const b = normalizeBody({ title: 'Solo', goal: 'g', milestones: [{ id: 'm', title: 'M', tasks: [{ id: 'a', title: 'A' }] }] }, [], planRepos(oldPlan));
    expect(b.milestones[0]).toEqual({ id: 'm', title: 'M', criteria: [], tasks: [{ id: 'a', title: 'A', acceptance: [], blockedBy: [] }] });
    expect(applyOps(b, [{ op: 'add_task', milestone: 'm', task: { title: 'B' } }], planRepos(oldPlan)).milestones[0]!.tasks).toHaveLength(2);
  });
});
