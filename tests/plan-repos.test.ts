import { describe, expect, it } from 'vitest';
import { PlanError, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { diffBodies, isMultiRepo, milestoneRepos, planRepos, type Plan } from '../src/core/plans/model.js';
import { initialState } from '../src/core/store.js';
import { planPageView } from '../src/companion/views.js';
import type { Project } from '../src/workspaces/types.js';

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

describe('the phone’s plan page names the repos (BLG-20)', () => {
  const project = (id: string, name: string): Project => ({ id, name, root: `/r/${id}`, base: 'main', workspaces: [] });
  const page = (over: Partial<Plan>) => {
    const p: Plan = { id: 'pl', projectId: 'p_api', home: 'ws:h', status: 'draft', draft: body(['p_cal']), draftRev: 1, autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', paused: false, runs: {}, activity: [], createdAt: 0, updatedAt: 0, ...over };
    const state = { ...initialState('room'), projects: [project('p_api', 'whisper-api'), project('p_cal', 'calendar-api'), project('p_desk', 'calendar-desktop')], plans: { enabled: true, plans: [p], style: '' } };
    return planPageView(state, 'pl')!;
  };

  it('a plan across repos: its repos, primary first, and each milestone’s', () => {
    const v = page({ repos: multi.repos });
    expect(v.repos).toEqual(['whisper-api', 'calendar-api', 'calendar-desktop']);
    expect(v.milestones.map((m) => m.repos)).toEqual([['calendar-api'], ['whisper-api']]);
  });

  it('a one-repo plan leaves them out', () => {
    const v = page({ draft: body() });
    expect('repos' in v).toBe(false);
    expect(v.milestones.every((m) => !('repos' in m))).toBe(true);
  });
});
