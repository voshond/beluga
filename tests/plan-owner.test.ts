import { describe, expect, it } from 'vitest';
import { NO_BOARD, type BoardState, type Issue } from '../src/core/board/model.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan, PlansState } from '../src/core/plans/model.js';
import { isLivePlan, isPlanOwned, planConversations, planOf, planOfPlace, planOwnerOf, planWorktrees } from '../src/core/plans/owner.js';

/** A plan's task worktrees belong to the plan: the sidebar shows the plan, and the plan merges them. */

const issue = (id: string, status: Issue['status'], worktrees: string[]): Issue =>
  ({ id, key: `X-${id}`, number: 1, projectId: 'x', title: id, status, priority: 'medium', labels: [], blockedBy: [], related: [], rank: 0, brief: {}, revisions: [], worktrees }) as unknown as Issue;
const body = normalizeBody({
  title: 'P',
  goal: 'g',
  milestones: [{ id: 'one', title: 'One', tasks: [{ id: 'a', title: 'A', issueId: 'ia' }, { id: 'b', title: 'B', issueId: 'ib' }, { id: 'c', title: 'C', issueId: 'ic' }] }],
});
const plan = (over: Partial<Plan> = {}): Plan => ({ id: 'p', projectId: 'x', home: 'ws:home', status: 'active', body, draftRev: 1, autonomy: 'gated', maxParallel: 3, paused: false, testsAt: 'end', runs: {}, activity: [], createdAt: 0, updatedAt: 0, ...over });
const board: BoardState = { ...NO_BOARD, issues: [issue('ia', 'in_progress', ['w1']), issue('ib', 'in_review', ['w2']), issue('ic', 'canceled', ['w3']), issue('free', 'in_progress', ['w4'])] };
const plans = (...list: Plan[]): PlansState => ({ enabled: true, plans: list, style: '' });

describe('which worktrees a plan owns', () => {
  it('its tasks’ worktrees, in progress or in review; not a canceled task’s, nor one outside the plan', () => {
    const owned = planWorktrees(plans(plan()), board);
    expect([...owned.keys()].sort()).toEqual(['w1', 'w2']);
    expect(owned.get('w1')).toBe('p');
    expect(planOwnerOf(plans(plan()), board, 'w2')?.task.id).toBe('b');
    expect(planOwnerOf(plans(plan()), board, 'w3')).toBeUndefined();
    expect(planOwnerOf(plans(plan()), board, 'w4')).toBeUndefined();
  });

  it('only while the plan runs: a draft or a finished plan owns nothing', () => {
    expect(planWorktrees(plans(plan({ status: 'done' })), board).size).toBe(0);
    expect(planWorktrees(plans(plan({ status: 'draft', body: undefined, draft: body })), board).size).toBe(0);
    expect(isLivePlan(plan({ status: 'draft' }))).toBe(true);
    expect(isLivePlan(plan({ status: 'done' }))).toBe(false);
  });

  it('a finished plan whose branch isn’t in main yet keeps its row, until it ships', () => {
    const pr = { number: 7, url: 'u', state: 'OPEN', title: 'P', draft: false, checks: 'none' } as const;
    expect(isLivePlan(plan({ status: 'done', branch: 'plan/p' }))).toBe(true);
    expect(isLivePlan(plan({ status: 'done', branch: 'plan/p', pr }))).toBe(true);
    expect(isLivePlan(plan({ status: 'done', branch: 'plan/p', pr: { ...pr, state: 'MERGED' } }))).toBe(false);
    expect(isLivePlan(plan({ status: 'done', branch: 'plan/p', shipped: { at: 1, how: 'local' } }))).toBe(false);
  });

  it('the plan a place is part of: its page, its conversation, one of its tasks', () => {
    const state = plans(plan());
    expect(planOfPlace(state, board, { kind: 'plan', id: 'p' })).toBe('p');
    expect(planOfPlace(state, board, { kind: 'workspace', id: 'home' })).toBe('p');
    expect(planOfPlace(state, board, { kind: 'workspace', id: 'w1' })).toBe('p');
    expect(planOfPlace(state, board, { kind: 'workspace', id: 'w4' })).toBeUndefined();
    expect(planOfPlace(state, board, { kind: 'overview' })).toBeUndefined();
  });
});

describe('the one rule: what folds into a plan (planOf)', () => {
  const st = (p: Plan) => ({ plans: plans(p), board });

  it('its home and its running tasks’ worktrees; not a canceled task’s, nor a worktree outside it', () => {
    const s = st(plan());
    expect(planOf(s, 'home')?.id).toBe('p');
    expect(planOf(s, 'w1')?.id).toBe('p');
    expect(isPlanOwned(s, 'w2')).toBe(true);
    expect(isPlanOwned(s, 'w3')).toBe(false);
    expect(isPlanOwned(s, 'w4')).toBe(false);
    expect(planConversations(s, 'p')).toEqual(['home', 'w1', 'w2']);
  });

  it('a plan being written owns its home only; a finished plan owns nothing', () => {
    expect(planConversations(st(plan({ status: 'draft', body: undefined, draft: body })), 'p')).toEqual(['home']);
    expect(isPlanOwned(st(plan({ status: 'done' })), 'home')).toBe(false);
    expect(isPlanOwned(st(plan({ status: 'done' })), 'w1')).toBe(false);
  });
});
