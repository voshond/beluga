import type { Board } from '../board/board.js';
import { criteria, criterionLine } from '../board/criteria.js';
import { labelsFor } from '../board/labels.js';
import { type Actor, type Assignee, type BriefSection, type Issue, boardOf, isOpen, reposOf } from '../board/model.js';
import { PlanError } from './edit.js';
import { type Plan, type PlanBody, type PlanTask, allTasks, decisionLines, diffBodies, isMultiRepo, milestoneDeps, milestoneRepos, planRepos, taskById } from './model.js';

/**
 * Approving a plan: its draft goes on the board. New tasks are made (in the plan's milestone, its
 * sub-tasks and blockers wired up), tasks that changed are rewritten (ticks kept), and tasks taken
 * out are canceled. Tasks of milestones that can be worked on now (what they build on has passed)
 * are Ready (todo); the others wait in the Backlog. Started work keeps its status. → the plan as approved, each task with its board task.
 */

export interface ApplyActors {
  readonly by: Actor;
  readonly me: Assignee;
}

export interface Applied {
  readonly body: PlanBody;
  readonly summary: string;
}

/** Approving failed partway: the board tasks made so far (plan task id → board task id), so a retry doesn't make them again. */
export class ApplyError extends Error {
  constructor(
    message: string,
    readonly linked: ReadonlyMap<string, string>,
  ) {
    super(message);
  }
}

const inPlanSet = (board: Board, issue: Issue, labels: readonly string[]): string[] => {
  const set = new Set(labelsFor(board.state(), boardOf(issue)).map((l) => l.name));
  return labels.map((l) => l.toLowerCase()).filter((l) => set.has(l) || issue.labels.includes(l));
};

const sameRepos = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((r) => b.includes(r));

/**
 * The board a plan across repos puts its tasks on (BLG-12): the one it has while that still covers
 * its repos, else one covering exactly them, else a new board of its own called `name` (the sidebar
 * group they're in, or the plan's title). A single-repo plan: none (each task on its repo's board).
 */
export function planBoard(plan: Plan, board: Board, name: string): string | undefined {
  if (!isMultiRepo(plan)) return undefined;
  const repos = planRepos(plan);
  const boards = board.state().projects;
  if (plan.board && boards[plan.board] && repos.every((r) => reposOf(board.state(), plan.board!).includes(r))) return plan.board;
  const same = Object.keys(boards).find((id) => sameRepos(reposOf(board.state(), id), repos));
  return same ?? board.createBoard({ name, repos });
}

export function applyDraft(plan: Plan, board: Board, actors: ApplyActors): Applied {
  const linked = new Map<string, string>();
  try {
    return applyInto(plan, board, actors, linked);
  } catch (err) {
    throw new ApplyError(err instanceof Error ? err.message : String(err), linked);
  }
}

function applyInto(plan: Plan, board: Board, actors: ApplyActors, linked: Map<string, string>): Applied {
  const draft = plan.draft;
  if (!draft) throw new PlanError('There are no changes to approve');
  if (!draft.milestones.length || !allTasks(draft).length) throw new PlanError('The plan has no tasks yet: ask your agent to write it first');
  const diff = diffBodies(plan.body, draft);
  const passed = (id: string): boolean => Boolean(plan.runs[id]?.passedAt);
  const waiting = new Set(draft.milestones.filter((m) => !passed(m.id) && !milestoneDeps(draft, m).every(passed)).map((m) => m.id));
  const issueOf = new Map<string, Issue>();
  // Tasks already on the board (still there) keep their board task.
  for (const { task } of allTasks(draft)) {
    const issue = task.issueId ? board.get(task.issueId) : undefined;
    if (issue) issueOf.set(task.id, issue);
  }

  // 1. Make or rewrite every task.
  for (const { task, milestone } of allTasks(draft)) {
    const link = { id: plan.id, milestone: milestone.id, task: task.id };
    const fresh = waiting.has(milestone.id) ? 'backlog' : 'todo';
    // Yours is assigned to you; Claude's is no one's (a task is for a person, BLG-278): who's on it shows while it runs.
    const assignee = task.assignee === 'me' ? actors.me : undefined;
    const existing = issueOf.get(task.id);
    const repo = milestoneRepos(plan, milestone)[0]!;
    if (!existing) {
      const made = board.create(
        {
          projectId: repo,
          ...(plan.board ? { board: plan.board } : {}),
          title: task.title,
          status: fresh,
          ...(assignee ? { assignee } : {}),
          ...(task.priority ? { priority: task.priority } : {}),
          ...(task.estimate ? { estimate: task.estimate } : {}),
          ...(task.labels?.length ? { labels: task.labels } : {}),
          brief: { ...briefOf(task), ...(decisionLines(draft, task.id).length ? { decisions: decisionLines(draft, task.id).join('\n') } : {}) },
          plan: link,
        },
        actors.by,
        'plan',
      );
      issueOf.set(task.id, made);
      linked.set(task.id, made.id);
      continue;
    }
    // Only what the plan itself changed is written: edits made on the board (by you or a task's Claude) stay.
    const old = taskById(plan.body, task.id);
    const moved = !old || allTasks(plan.body).find((t) => t.task.id === task.id)?.milestone.id !== milestone.id;
    const notStarted = existing.status === 'todo' || existing.status === 'backlog';
    // Canceled on the board stays canceled, unless the plan takes it back in.
    const revived = existing.status === 'canceled' && diff.added.includes(task.id);
    const differs = <K extends keyof PlanTask>(key: K): boolean => !old || JSON.stringify(old[key]) !== JSON.stringify(task[key]);
    board.update(
      existing.id,
      {
        ...(old && differs('title') ? { title: task.title } : {}),
        ...(task.priority && differs('priority') ? { priority: task.priority } : {}),
        ...(task.estimate && differs('estimate') ? { estimate: task.estimate } : {}),
        // Claude wrote the plan: its labels come from the project's set (and any the task already had).
        ...(task.labels && old && differs('labels') ? { labels: inPlanSet(board, existing, task.labels) } : {}),
        ...((notStarted && moved && existing.status !== fresh) || revived ? { status: fresh } : {}),
        // A plan across repos: a task not started yet follows its milestone to another repo.
        ...(plan.board && notStarted && existing.projectId !== repo ? { projectId: repo } : {}),
      },
      actors.by,
    );
    board.setPlan(existing.id, link, actors.by);
    const now = board.need(existing.id);
    const brief = briefOf(task, now.brief.acceptance);
    const was = old ? briefOf(old, now.brief.acceptance) : {};
    for (const section of ['goal', 'context', 'acceptance'] as const) {
      const text = brief[section] ?? '';
      // A task taken in from the board keeps its own brief where it has one.
      const changed = old ? text !== (was[section] ?? '') : !now.brief[section];
      if (text && changed && text !== (now.brief[section] ?? '')) board.editBrief(existing.id, section, text, actors.by, { reason: 'the plan changed' });
    }
    // Decisions the plan made for it (BLG-8) join its brief's Decisions; what's there already stays.
    const had = now.brief.decisions ?? '';
    const decided = decisionLines(draft, task.id).filter((l) => !had.includes(l));
    if (decided.length) board.editBrief(existing.id, 'decisions', decided.join('\n'), actors.by, { mode: 'append', reason: 'decided while planning' });
  }

  // 2. Sub-tasks and blockers (all tasks exist now). Blockers from outside the plan are left alone.
  const planIssues = new Set([...issueOf.values()].map((i) => i.id));
  for (const { task } of allTasks(draft)) {
    const issue = board.need(issueOf.get(task.id)!.id);
    const parent = task.parent ? issueOf.get(task.parent)?.id : undefined;
    if ((parent ?? undefined) !== issue.parent && (parent || (issue.parent && planIssues.has(issue.parent)))) board.update(issue.id, { parent: parent ?? null }, actors.by);
    const want = new Set(task.blockedBy.map((b) => issueOf.get(b)?.id).filter((x): x is string => Boolean(x)));
    for (const id of want) if (!issue.blockedBy.includes(id)) board.relate(issue.id, 'blocked_by', id, true, actors.by);
    for (const id of issue.blockedBy) if (planIssues.has(id) && !want.has(id)) board.relate(issue.id, 'blocked_by', id, false, actors.by);
  }

  // 3. Taken out of the plan: canceled if unfinished, and no longer the plan's.
  const kept = new Set(allTasks(draft).map((t) => t.task.id));
  for (const { task } of allTasks(plan.body)) {
    if (kept.has(task.id) || !task.issueId) continue;
    const issue = board.get(task.issueId);
    if (!issue) continue;
    if (isOpen(issue.status) && issue.status !== 'in_review') board.update(issue.id, { status: 'canceled' }, actors.by);
    board.setPlan(issue.id, undefined, actors.by, 'took this out of the plan');
  }

  const body: PlanBody = {
    ...draft,
    milestones: draft.milestones.map((m) => ({ ...m, tasks: m.tasks.map((t) => ({ ...t, issueId: issueOf.get(t.id)!.id })) })),
  };
  const n = allTasks(body).length;
  const summary = plan.body
    ? [diff.added.length ? `${diff.added.length} new` : '', diff.changed.length ? `${diff.changed.length} changed` : '', diff.removed.length ? `${diff.removed.length} taken out` : ''].filter(Boolean).join(', ') || 'milestones changed'
    : `${body.milestones.length} ${body.milestones.length === 1 ? 'milestone' : 'milestones'}, ${n} ${n === 1 ? 'task' : 'tasks'}`;
  return { body, summary };
}

/** A plan task's brief on the board (`ticked`: the board's checklist now, whose ticks stay). */
export function briefOf(task: PlanTask, ticked?: string): Partial<Record<BriefSection, string>> {
  // Ticks and reasons (deferred, not done) stay with their criterion.
  const now = new Map(criteria(ticked).map((c) => [c.text, c]));
  const acceptance = task.acceptance.map((a) => criterionLine(now.get(a) ?? { text: a, state: 'open' })).join('\n');
  return {
    ...(task.goal ? { goal: task.goal } : {}),
    ...(task.context ? { context: task.context } : {}),
    ...(acceptance ? { acceptance } : {}),
  };
}

/** A milestone's tasks come out of the Backlog (what it builds on passed). */
export function openMilestone(plan: Plan, milestoneId: string, board: Board, by: Actor): void {
  const m = plan.body?.milestones.find((x) => x.id === milestoneId);
  for (const t of m?.tasks ?? []) {
    const issue = t.issueId ? board.get(t.issueId) : undefined;
    if (issue?.status === 'backlog') board.update(issue.id, { status: 'todo' }, by);
  }
}
