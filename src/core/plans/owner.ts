import type { BoardState, Issue } from '../board/model.js';
import { type Plan, type PlanMilestone, type PlanTask, type PlansState, allTasks, checkerOf, planById, planForHome } from './model.js';

/**
 * Which plan a worktree belongs to: one doing a task of a plan that's still running (its task not
 * canceled). Such a worktree is part of the plan, not something of its own: the sidebar shows the
 * plan instead of it, and Beluga (not you) merges it into the plan. Pure and browser-safe
 * (tests/plan-owner.test.ts).
 */

export interface PlanOwner {
  readonly plan: Plan;
  readonly task: PlanTask;
  readonly milestone: PlanMilestone;
  readonly issue: Issue;
}

/**
 * Plans that show in the sidebar as one row: being written, running, or every milestone passed
 * with its branch not in main yet (its pull request still to open or merge): it goes once it ships.
 */
export const isLivePlan = (plan: Plan): boolean => plan.status !== 'done' || (Boolean(plan.branch) && !plan.shipped && plan.pr?.state !== 'MERGED');

/** Every worktree that belongs to a running plan (workspace id → its plan's id). */
export function planWorktrees(plans: PlansState, board: BoardState): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const issues = new Map(board.issues.map((i) => [i.id, i]));
  for (const plan of plans.plans) {
    if (plan.status !== 'active') continue;
    for (const { task } of allTasks(plan.body)) {
      const issue = task.issueId ? issues.get(task.issueId) : undefined;
      if (!issue || issue.status === 'canceled') continue;
      for (const ws of issue.worktrees) out.set(ws, plan.id);
    }
  }
  return out;
}

/** The running plan a worktree does a task of, if any. */
export function planOwnerOf(plans: PlansState, board: BoardState, workspaceId: string): PlanOwner | undefined {
  for (const plan of plans.plans) {
    if (plan.status !== 'active') continue;
    for (const { task, milestone } of allTasks(plan.body)) {
      const issue = task.issueId ? board.issues.find((i) => i.id === task.issueId) : undefined;
      if (issue && issue.status !== 'canceled' && issue.worktrees.includes(workspaceId)) return { plan, task, milestone, issue };
    }
  }
  return undefined;
}

/** Who folds into whom, worked out once per plans and board (screens ask it for every row). */
const folds = new WeakMap<PlansState, { readonly board: BoardState; readonly map: ReadonlyMap<string, Plan> }>();

function foldMap(plans: PlansState, board: BoardState): ReadonlyMap<string, Plan> {
  const hit = folds.get(plans);
  if (hit?.board === board) return hit.map;
  const map = new Map<string, Plan>();
  // Its home, while it's live (the newest plan of a conversation wins, as planForHome).
  for (const plan of plans.plans) if (isLivePlan(plan) && plan.home.startsWith('ws:')) map.set(plan.home.slice(3), plan);
  // The conversations that check its milestones.
  for (const plan of plans.plans) if (isLivePlan(plan)) for (const run of Object.values(plan.runs ?? {})) if (run?.checker) map.set(run.checker, plan);
  for (const [ws, id] of planWorktrees(plans, board)) map.set(ws, planById(plans, id)!);
  folds.set(plans, { board, map });
  return map;
}

/**
 * The one rule for “this conversation is part of a plan”: the live plan a workspace folds into,
 * its home conversation (while the plan is being written or runs) or one of its running tasks'
 * worktrees. Such a workspace never stands on its own at the top level: the sidebar, Unread,
 * the bell and Overview show the plan instead (the same places planOfChannel in core/notify.ts
 * finds, narrowed to plans that are live).
 */
export const planOf = (state: { readonly plans: PlansState; readonly board: BoardState }, workspaceId: string): Plan | undefined => foldMap(state.plans, state.board).get(workspaceId);

export const isPlanOwned = (state: { readonly plans: PlansState; readonly board: BoardState }, workspaceId: string): boolean => planOf(state, workspaceId) !== undefined;

/** Every workspace folded into a plan: its home first (when it's a workspace), then its tasks' worktrees. */
export function planConversations(state: { readonly plans: PlansState; readonly board: BoardState }, planId: string): readonly string[] {
  const out: string[] = [];
  for (const [ws, plan] of foldMap(state.plans, state.board)) if (plan.id === planId) out.push(ws);
  return out;
}

/**
 * The plan a place is part of: a plan's own page, its home conversation, or one of its task
 * worktrees (so the sidebar marks the plan's row while you're in any of them).
 */
export function planOfPlace(plans: PlansState, board: BoardState, view: { readonly kind: string; readonly id?: string }): string | undefined {
  if (view.kind === 'plan') return view.id;
  if (view.kind !== 'workspace' || !view.id) return undefined;
  const home = planForHome(plans, `ws:${view.id}`) ?? checkerOf(plans, `ws:${view.id}`)?.plan;
  return home?.id ?? planOwnerOf(plans, board, view.id)?.plan.id;
}
