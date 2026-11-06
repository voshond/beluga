import type { Board } from '../board/board.js';
import { type Actor, type Issue, type IssueStatus, boardOf, isOpen } from '../board/model.js';
import { type Plan, type PlanEpics, type PlanMilestone, allTasks, milestoneDeps, milestoneRepos, planRepos, planTitle } from './model.js';

/**
 * A plan's shape on the board: one epic for the plan, one epic under it for each milestone, and the
 * milestone's tasks under that (a task's own sub-tasks stay under it). So Tasks reads as the plan
 * does, and each level folds and unfolds with the eye like any epic. The epics hold no work of
 * their own: they follow their tasks (see Board.rollUp), and the pilot never starts them.
 * Kept true each time the plan is approved or changes; plans from before catch up once.
 */

const MAX_TITLE = 200;

/** Where a milestone epic starts: Ready once it can be worked on (what it builds on passed), else the Backlog. */
function startsAt(plan: Plan, m: PlanMilestone): IssueStatus {
  const body = plan.body!;
  const passed = (id: string): boolean => Boolean(plan.runs[id]?.passedAt);
  return passed(m.id) || milestoneDeps(body, m).every(passed) ? 'todo' : 'backlog';
}

const milestoneBrief = (m: PlanMilestone): { goal?: string; context?: string } => ({
  ...(m.goal ? { goal: m.goal } : {}),
  ...(m.criteria.length ? { context: ['A milestone of its plan: it passes when its checker finds these true.', '', 'Pass criteria:', ...m.criteria.map((c) => `- ${c}`)].join('\n') } : {}),
});

/** An epic still there to use (not deleted, not canceled, in that repo, on that board). */
const usable = (board: Board, id: string | undefined, projectId: string | undefined, boardId?: string): Issue | undefined => {
  const issue = id ? board.get(id) : undefined;
  return issue && issue.status !== 'canceled' && (!projectId || issue.projectId === projectId) && (!boardId || boardOf(issue) === boardId) ? issue : undefined;
};

/** Every epic of the plan's own that it keeps (the plan's, once per repo, and each milestone's). */
const epicIds = (epics: PlanEpics | undefined): string[] => (epics ? [epics.plan, ...Object.values(epics.repos ?? {}), ...Object.values(epics.milestones)] : []);

/**
 * Make or bring up to date the plan's epics, and hang its tasks under them. → the epics (what to
 * keep on the plan); undefined when the plan has nothing on the board yet.
 *
 * On its repos' own boards (BLG-34) the plan's epic is made in each repo its milestones run in (a
 * sub-task is on its parent's board), each milestone's under its repo's. A plan that kept a board of its
 * own (BLG-12) has one plan epic there, as before. A task never moves to another board to follow an epic.
 */
export function syncEpics(plan: Plan, board: Board, by: Actor): PlanEpics | undefined {
  const body = plan.body;
  if (!body || !allTasks(body).some((t) => t.task.issueId)) return undefined;
  const title = planTitle(plan).slice(0, MAX_TITLE);
  const boardFor = (repo: string): string => plan.board ?? repo;
  const homeOf = (m: PlanMilestone): string => (plan.board ? plan.projectId : milestoneRepos(plan, m)[0]!);
  const used = new Set(body.milestones.map(homeOf));
  const homes = planRepos(plan).filter((r) => used.has(r));
  const before = epicIds(plan.epics);

  // The plan's own epic, in each repo its milestones run in (the primary first).
  const tops = new Map<string, Issue>();
  for (const repo of homes.length ? homes : [plan.projectId]) {
    const had = [plan.epics?.plan, ...Object.values(plan.epics?.repos ?? {})].map((id) => usable(board, id, repo, boardFor(repo))).find(Boolean);
    const top = had ?? board.create({ projectId: repo, ...(plan.board ? { board: plan.board } : {}), title, status: 'todo', brief: body.goal ? { goal: body.goal } : {} }, by, 'plan');
    tops.set(repo, top.title === title ? top : board.update(top.id, { title }, by));
  }
  const [first, ...rest] = [...tops.entries()];
  const repos = Object.fromEntries(rest.map(([repo, top]) => [repo, top.id]));

  // One epic per milestone, under its repo's plan epic.
  const milestones: Record<string, string> = {};
  for (const m of body.milestones) {
    const brief = milestoneBrief(m);
    const repo = milestoneRepos(plan, m)[0]!;
    const top = tops.get(homeOf(m))!;
    let epic = usable(board, plan.epics?.milestones[m.id], plan.board ? undefined : repo, boardFor(repo));
    if (epic && epic.projectId !== repo) epic = board.update(epic.id, { projectId: repo }, by);
    if (!epic) {
      epic = board.create({ projectId: repo, ...(plan.board ? { board: plan.board } : {}), title: m.title.slice(0, MAX_TITLE), status: startsAt(plan, m), parent: top.id, brief }, by, 'plan');
    } else {
      if (epic.title !== m.title || epic.parent !== top.id) epic = board.update(epic.id, { ...(epic.title !== m.title ? { title: m.title.slice(0, MAX_TITLE) } : {}), ...(epic.parent !== top.id ? { parent: top.id } : {}) }, by);
      for (const section of ['goal', 'context'] as const) {
        const text = brief[section];
        if (text && text !== (epic.brief[section] ?? '')) board.editBrief(epic.id, section, text, by, { reason: 'the plan changed' });
      }
    }
    milestones[m.id] = epic.id;
  }
  const ours = new Set([...tops.values()].map((t) => t.id).concat(Object.values(milestones)));

  // Each task under its milestone (a sub-task under its own parent task), on its own board. A parent
  // from outside the plan (a task adopted from an epic of yours) is left alone.
  const planIssues = new Set(allTasks(body).flatMap((t) => (t.task.issueId ? [t.task.issueId] : [])));
  const fromPlan = (id: string | undefined): boolean => !id || planIssues.has(id) || ours.has(id) || before.includes(id);
  const issueOfTask = new Map(allTasks(body).map((t) => [t.task.id, t.task.issueId]));
  for (const { task, milestone } of allTasks(body)) {
    const issue = task.issueId ? board.get(task.issueId) : undefined;
    if (!issue) continue;
    const want = (task.parent ? issueOfTask.get(task.parent) : undefined) ?? milestones[milestone.id]!;
    const there = board.get(want);
    if (issue.parent !== want && fromPlan(issue.parent) && there && boardOf(there) === boardOf(issue)) board.update(issue.id, { parent: want }, by);
  }
  // Tasks taken out of the plan don't stay under its epics.
  for (const issue of board.list()) {
    if (issue.parent && ours.has(issue.parent) && !planIssues.has(issue.id) && !ours.has(issue.id)) board.update(issue.id, { parent: null }, by);
  }
  // Epics it no longer keeps: a milestone taken out goes (canceled); one replaced (its milestone moved repo) once nothing open is under it.
  const gone = new Set(Object.entries(plan.epics?.milestones ?? {}).filter(([id]) => !milestones[id]).map(([, epic]) => epic));
  for (const id of before.filter((x) => !ours.has(x))) {
    const epic = board.get(id);
    if (epic && isOpen(epic.status) && (gone.has(id) || !board.list().some((i) => i.parent === id && isOpen(i.status)))) board.update(epic.id, { status: 'canceled', parent: null }, by);
  }
  return { plan: first![1].id, milestones, ...(rest.length ? { repos } : {}) };
}

/** A milestone's epic comes out of the Backlog with its tasks. */
export function openMilestoneEpic(plan: Plan, milestoneId: string, board: Board, by: Actor): void {
  const id = plan.epics?.milestones[milestoneId];
  const epic = id ? board.get(id) : undefined;
  if (epic?.status === 'backlog') board.update(epic.id, { status: 'todo' }, by);
}

/** The plan is deleted: its epics go too (canceled; its tasks stay where they are, out from under them). */
export function dropEpics(plan: Plan, board: Board, by: Actor): void {
  const ids = epicIds(plan.epics);
  const ours = new Set(ids);
  for (const issue of board.list()) if (issue.parent && ours.has(issue.parent) && !ours.has(issue.id)) board.update(issue.id, { parent: null }, by);
  for (const id of ids) {
    const epic = board.get(id);
    if (epic && isOpen(epic.status)) board.update(epic.id, { status: 'canceled' }, by);
  }
}
