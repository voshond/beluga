import { ESTIMATES, PRIORITIES, type Priority } from '../board/model.js';
import { AUTONOMIES, type Autonomy, MAX_PLAN_REPOS, type PlanBody, type PlanDecision, type PlanDecisionEntry, decisionText, type PlanMilestone, type PlanRepoChange, type PlanTask, allTasks, reposWith, runOf } from './model.js';

/**
 * Writing a plan: a whole one (Claude's plan_write), or a change at a time (Claude's plan_update,
 * and you on the plan's page). Input is read kindly (ids made from titles, a checklist as text);
 * the result is checked: ids unique, blockers and milestone dependencies that exist and never wait
 * on a later milestone, no loops. Ids Claude used before keep their board task. Browser-safe.
 */

export class PlanError extends Error {}

const MAX_TITLE = 200;
const MAX_GOAL = 4000;
const MAX_CONTEXT = 8000;
const MAX_LINES = 20;
const MAX_LINE = 400;
const MAX_TOUCHES = 20;

export interface TaskInput {
  readonly id?: string;
  readonly title: string;
  readonly goal?: string;
  readonly context?: string;
  /** A list, or a "- [ ]" checklist as text. */
  readonly acceptance?: readonly string[] | string;
  readonly blockedBy?: readonly string[];
  readonly parent?: string | null;
  readonly priority?: Priority;
  readonly estimate?: number | null;
  readonly labels?: readonly string[];
  readonly touches?: readonly string[];
  readonly assignee?: 'claude' | 'me';
  /** A task for you: what you're asked when it's ready (see PlanDecision). */
  readonly decision?: PlanDecision;
  /** A task already on the board that this plan task is (adopted into the plan). */
  readonly issueId?: string;
}

/** A decision as given: trimmed and capped; none without a question. */
function decisionOf(input: PlanDecision | undefined): PlanDecision | undefined {
  const question = block(input?.question, 1000);
  if (!input || !question) return undefined;
  const seen = new Set<string>();
  const options = input.options
    .map((o) => ({ label: oneLine(o.label ?? '', 200), description: block(o.description, 600) }))
    .filter((o) => o.label && !seen.has(o.label) && seen.add(o.label))
    .slice(0, 6)
    .map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
  const run = runOf(input.run);
  return { question, options, ...(input.multi ? { multi: true } : {}), ...(run ? { run } : {}) };
}

export interface MilestoneInput {
  readonly id?: string;
  readonly title: string;
  readonly goal?: string;
  readonly criteria?: readonly string[] | string;
  readonly tasks?: readonly TaskInput[];
  readonly autonomy?: Autonomy;
  /** Earlier milestones it builds on (ids); left out, inferred from its tasks' blockers. */
  readonly dependsOn?: readonly string[];
  /** The repos it works in (project ids of the plan's); left out, the plan's primary. */
  readonly repos?: readonly string[];
}

export interface BodyInput {
  readonly title: string;
  readonly goal: string;
  readonly milestones: readonly MilestoneInput[];
  /** Left out: the plan's decisions stay as they were. */
  readonly decisions?: readonly DecisionInput[];
  readonly openQuestions?: readonly string[];
  /** Repos to add to the plan (on) or drop from it (off), applied when it's approved. */
  readonly repoEdits?: readonly RepoChangeInput[];
}

/** A repo in (on) or out of (off) the plan (BLG-29): a project id, and why. */
export interface RepoChangeInput {
  readonly repo: string;
  readonly on: boolean;
  readonly why?: string;
  readonly by?: 'claude' | 'user';
}

/**
 * A decision as Claude writes it (BLG-8): `by` left out is a default it chose. `supersedes` names
 * the one it replaces; one for a question already decided replaces that one anyway (BLG-772).
 */
export interface DecisionInput {
  readonly id?: string;
  readonly question: string;
  readonly answer: string;
  readonly why?: string;
  readonly by?: 'user' | 'default';
  readonly tasks?: readonly string[];
  readonly terms?: readonly string[];
  readonly retires?: readonly string[];
  /** The decision it replaces (its id). */
  readonly supersedes?: string;
}

export type PlanOp =
  | { readonly op: 'retitle'; readonly title?: string; readonly goal?: string }
  | { readonly op: 'add_milestone'; readonly milestone: MilestoneInput; readonly after?: string }
  | { readonly op: 'update_milestone'; readonly id: string; readonly title?: string; readonly goal?: string; readonly criteria?: readonly string[] | string; readonly autonomy?: Autonomy | null; readonly dependsOn?: readonly string[] | null; readonly repos?: readonly string[] | null }
  | { readonly op: 'remove_milestone'; readonly id: string }
  | { readonly op: 'add_task'; readonly milestone: string; readonly task: TaskInput; readonly after?: string }
  | { readonly op: 'update_task'; readonly id: string; readonly patch: Partial<TaskInput> }
  | { readonly op: 'remove_task'; readonly id: string }
  | { readonly op: 'move_task'; readonly id: string; readonly milestone: string; readonly before?: string }
  | { readonly op: 'block'; readonly id: string; readonly by: string; readonly on: boolean }
  /** Settle a question (a new decision, or a new answer to one): it's no longer open (BLG-8). */
  | { readonly op: 'decide'; readonly decision: DecisionInput }
  /** A question still to settle (on), or settled or dropped (off). */
  | { readonly op: 'open_question'; readonly question: string; readonly on: boolean }
  /** A repo in or out of the plan, once it's approved (BLG-29). */
  | {
      readonly op: 'update_decision';
      readonly id: string;
      readonly question?: string;
      readonly answer?: string;
      readonly why?: string;
      readonly tasks?: readonly string[];
      readonly terms?: readonly string[];
      readonly retires?: readonly string[];
    }
  | { readonly op: 'remove_decision'; readonly id: string }
  /** A repo in or out of the plan, once it's approved (BLG-29). */
  | ({ readonly op: 'repo' } & RepoChangeInput);

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const block = (text: string | undefined, max: number): string | undefined => {
  const t = text?.trim();
  return t ? t.slice(0, max) : undefined;
};

/** "Add the login API" → "add-the-login-api" (letters, digits and dashes). */
export function slugId(text: string): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return s || 'item';
}

/** A checklist or list as lines, without their "- [ ]" marks. */
export function lines(input: readonly string[] | string | undefined): string[] {
  const raw = typeof input === 'string' ? input.split('\n') : [...(input ?? [])];
  return raw
    .map((l) => oneLine(l.replace(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''), MAX_LINE))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

/**
 * A new item's id (`taken` grows with it). One that's taken is refused, never renamed: a silent
 * "-2" kept a stale task beside its replacement (BLG-772). `held` says what holds an id, for the error.
 */
function newId(wanted: string | undefined, fallback: string, taken: Set<string>, what: 'task' | 'milestone' | 'decision', held: (id: string) => string | undefined): string {
  const id = slugId(wanted?.trim() || fallback);
  if (taken.has(id)) {
    const holder = held(id);
    const change = what === 'task' ? 'update_task' : what === 'milestone' ? 'update_milestone' : 'update_decision';
    const remove = what === 'task' ? 'remove_task' : what === 'milestone' ? 'remove_milestone' : 'remove_decision';
    const named = wanted?.trim() ? '' : ' (its id comes from its title)';
    throw new PlanError(`There's already a ${what} "${id}"${holder ? `: ${holder}` : ''}. Change that one with ${change}, take it out first with ${remove}, or give the new ${what} an id of its own${named}`);
  }
  taken.add(id);
  return id;
}

const taskHolder = (body: PlanBody) => (id: string): string | undefined => {
  const hit = allTasks(body).find((t) => t.task.id === id);
  return hit ? `“${hit.task.title}”, in milestone “${hit.milestone.title}”` : undefined;
};
const milestoneHolder = (body: PlanBody) => (id: string): string | undefined => {
  const m = body.milestones.find((x) => x.id === id);
  return m ? `“${m.title}”` : undefined;
};
const decisionHolder = (list: readonly PlanDecisionEntry[]) => (id: string): string | undefined => {
  const d = list.find((x) => x.id === id);
  return d ? `“${oneLine(decisionText(d), 120)}”` : undefined;
};

function task(input: TaskInput, id: string, keep?: PlanTask): PlanTask {
  const title = oneLine(input.title ?? '', MAX_TITLE);
  if (!title) throw new PlanError('Every task needs a title');
  const priority = input.priority && PRIORITIES.includes(input.priority) ? input.priority : undefined;
  const estimate = input.estimate && (ESTIMATES as readonly number[]).includes(input.estimate) ? input.estimate : undefined;
  const labels = [...new Set((input.labels ?? []).map((l) => oneLine(l, 32).toLowerCase()).filter(Boolean))].slice(0, 8);
  const touches = [...new Set((input.touches ?? []).map((t) => oneLine(t, 200)).filter(Boolean))].slice(0, MAX_TOUCHES);
  const goal = block(input.goal, MAX_GOAL);
  const context = block(input.context, MAX_CONTEXT);
  const decision = input.assignee === 'me' ? decisionOf(input.decision) : undefined;
  return {
    id,
    title,
    ...(goal ? { goal } : {}),
    ...(context ? { context } : {}),
    acceptance: lines(input.acceptance),
    blockedBy: [...new Set((input.blockedBy ?? []).map((b) => b.trim()).filter(Boolean))],
    ...(input.parent ? { parent: input.parent.trim() } : {}),
    ...(priority && priority !== 'none' ? { priority } : {}),
    ...(estimate ? { estimate } : {}),
    ...(labels.length ? { labels } : {}),
    ...(touches.length ? { touches } : {}),
    ...(input.assignee === 'me' ? { assignee: 'me' as const } : {}),
    ...(decision ? { decision } : {}),
    ...((input.issueId ?? keep?.issueId) ? { issueId: (input.issueId ?? keep?.issueId)! } : {}),
  };
}

function milestone(input: MilestoneInput, id: string, tasks: readonly PlanTask[]): PlanMilestone {
  const title = oneLine(input.title ?? '', MAX_TITLE);
  if (!title) throw new PlanError('Every milestone needs a title');
  const goal = block(input.goal, MAX_GOAL);
  const repos = [...new Set((input.repos ?? []).map((r) => r.trim()).filter(Boolean))];
  return {
    id,
    title,
    ...(goal ? { goal } : {}),
    criteria: lines(input.criteria),
    tasks,
    ...(input.autonomy && AUTONOMIES.includes(input.autonomy) ? { autonomy: input.autonomy } : {}),
    ...(input.dependsOn ? { dependsOn: [...new Set(input.dependsOn.map((d) => d.trim()).filter(Boolean))] } : {}),
    ...(repos.length ? { repos } : {}),
  };
}

/**
 * A whole plan from Claude: ids made where missing (from titles), and tasks Claude named before
 * keep the board task they have (`previous`: the plan as it was, approved or drafted).
 */
export function normalizeBody(input: BodyInput, previous?: readonly (PlanBody | undefined)[], repos?: readonly string[]): PlanBody {
  const title = oneLine(input.title ?? '', MAX_TITLE);
  if (!title) throw new PlanError('The plan needs a title');
  const known = new Map<string, PlanTask>();
  for (const body of previous ?? []) for (const { task: t } of allTasks(body)) if (!known.has(t.id) || t.issueId) known.set(t.id, t);
  const milestoneIds = new Set<string>();
  const taskIds = new Set<string>();
  // What holds each id so far, for a clear error when two would share one.
  const held = new Map<string, string>();
  // Ids as written first, so a task's blockers can name tasks further down.
  const milestones = (input.milestones ?? []).map((m) => {
    const id = newId(m.id, m.title, milestoneIds, 'milestone', (x) => held.get(`m:${x}`));
    held.set(`m:${id}`, `“${oneLine(m.title ?? '', 120)}”`);
    const tasks = (m.tasks ?? []).map((t) => {
      const tid = newId(t.id, t.title, taskIds, 'task', (x) => held.get(`t:${x}`));
      held.set(`t:${tid}`, `“${oneLine(t.title ?? '', 120)}”, in milestone “${oneLine(m.title ?? '', 120)}”`);
      return task(t, tid, known.get(tid));
    });
    return milestone(m, id, tasks);
  });
  const goal = block(input.goal, MAX_GOAL) ?? '';
  // Decisions are the plan's: a whole new plan that says none keeps the ones it had.
  const decisions = input.decisions ? decisionsOf(input.decisions) : (previous?.find((b) => b?.decisions)?.decisions ?? []);
  const openQuestions = questionList(input.openQuestions ?? []).filter((q) => !decisions.some((d) => !d.supersededBy && sameText(d.question, q)));
  // The repo changes drafted before stay (a whole plan rewrites the milestones, not which repos it covers).
  const kept = withRepoChanges({ title, goal, milestones, ...(decisions.length ? { decisions } : {}), ...(openQuestions.length ? { openQuestions } : {}) }, previous?.[0]?.repoChanges ?? []);
  const body = (input.repoEdits ?? []).reduce((b, c) => withRepo(b, c, repos), kept);
  return checkBody(body, repos && reposWith(repos, body.repoChanges));
}

/** The body with these repo changes (none: the field goes). */
function withRepoChanges(body: PlanBody, changes: readonly PlanRepoChange[]): PlanBody {
  const { repoChanges: _r, ...rest } = body;
  return changes.length ? { ...rest, repoChanges: changes } : rest;
}

/**
 * A repo in or out of the plan (`base`: its repos now, primary first). In one it already covers, or
 * out of one it doesn't, takes back a change drafted before. The primary always stays.
 */
function withRepo(body: PlanBody, input: RepoChangeInput, base: readonly string[] | undefined): PlanBody {
  if (!base?.length) throw new PlanError('This plan’s repos aren’t known here');
  const repo = input.repo.trim();
  if (!repo) throw new PlanError('Say which repo');
  if (!input.on && repo === base[0]) throw new PlanError('The plan’s primary repo stays in it: its conversation runs there');
  if (!input.on) {
    const using = body.milestones.find((m) => m.repos?.includes(repo));
    if (using) throw new PlanError(`Milestone "${using.id}" works in "${repo}": move it to another repo (update_milestone repos) before dropping it`);
  }
  const inPlan = base.includes(repo);
  const change: PlanRepoChange['change'] | undefined = input.on ? (inPlan ? undefined : 'add') : inPlan ? 'drop' : undefined;
  const why = input.why ? oneLine(input.why, MAX_LINE) : '';
  const rest = (body.repoChanges ?? []).filter((c) => c.repo !== repo);
  const next: PlanRepoChange[] = change ? [...rest, { repo, change, ...(why ? { why } : {}), by: input.by === 'user' ? 'user' : 'claude' }] : rest;
  if (reposWith(base, next).length > MAX_PLAN_REPOS) throw new PlanError(`A plan covers at most ${MAX_PLAN_REPOS} repos`);
  return withRepoChanges(body, next);
}

const MAX_DECISIONS = 60;
const MAX_TERMS = 8;
const sameText = (a: string, b: string): boolean => oneLine(a, MAX_LINE).toLowerCase() === oneLine(b, MAX_LINE).toLowerCase();
const termList = (input: readonly string[] | undefined): string[] => [...new Set((input ?? []).map((t) => oneLine(t, 60)).filter((t) => t.length >= 2))].slice(0, MAX_TERMS);

function decisionEntry(d: DecisionInput, id: string, keep?: PlanDecisionEntry): PlanDecisionEntry {
  const question = oneLine(d.question ?? '', MAX_LINE);
  const answer = oneLine(d.answer ?? '', MAX_LINE);
  if (!question || !answer) throw new PlanError('Every decision needs its question and its answer');
  const why = d.why ? oneLine(d.why, MAX_LINE) : '';
  const tasks = [...new Set((d.tasks ?? []).map((t) => t.trim()).filter(Boolean))];
  const terms = termList(d.terms ?? keep?.terms);
  const retires = termList(d.retires ?? keep?.retires);
  const supersedes = d.supersedes?.trim() || keep?.supersedes;
  return {
    id,
    question,
    answer,
    ...(why ? { why } : {}),
    by: d.by === 'user' ? 'user' : 'default',
    ...(tasks.length ? { tasks } : {}),
    ...(terms.length ? { terms } : {}),
    ...(retires.length ? { retires } : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(keep?.supersededBy ? { supersededBy: keep.supersededBy } : {}),
  };
}

/** A new decision's id: the one asked for (refused when taken), or one made from its question. */
function decisionId(input: DecisionInput, list: readonly PlanDecisionEntry[]): string {
  const taken = new Set(list.map((d) => d.id));
  if (input.id?.trim()) return newId(input.id, input.question, taken, 'decision', decisionHolder(list));
  const base = slugId(input.question ?? '') || 'decision';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * A decision added. The one it replaces (named in `supersedes`, or the one in force for the same
 * question) is kept for the record, marked replaced (BLG-772); the same answer again only updates it.
 */
function addDecision(list: readonly PlanDecisionEntry[], made: PlanDecisionEntry): PlanDecisionEntry[] {
  if (made.supersedes) {
    const named = list.find((d) => d.id === made.supersedes);
    if (!named) throw new PlanError(`Decision "${made.id}" supersedes "${made.supersedes}", which isn't one of the plan's decisions (${list.map((d) => d.id).join(', ') || 'none yet'})`);
    if (named.supersededBy) throw new PlanError(`Decision "${named.id}" was already superseded by "${named.supersededBy}": supersede that one instead`);
  }
  const old = made.supersedes ? list.find((d) => d.id === made.supersedes) : list.find((d) => !d.supersededBy && sameText(d.question, made.question));
  if (old && !made.supersedes && sameText(old.answer, made.answer)) return list.map((d) => (d.id === old.id ? { ...made, id: old.id, ...(old.supersedes ? { supersedes: old.supersedes } : {}) } : d));
  if (list.length >= MAX_DECISIONS) throw new PlanError(`A plan keeps up to ${MAX_DECISIONS} decisions: remove ones that no longer matter`);
  const replacing = old ? { ...made, supersedes: old.id } : made;
  return [...list.map((d) => (old && d.id === old.id ? { ...d, supersededBy: made.id } : d)), replacing];
}

/** Decisions from a whole plan: ids made where missing; a question written twice keeps the later answer in its place. */
function decisionsOf(input: readonly DecisionInput[]): PlanDecisionEntry[] {
  let list: PlanDecisionEntry[] = [];
  for (const d of input) {
    const same = d.supersedes ? undefined : list.find((x) => !x.supersededBy && sameText(x.question, d.question ?? ''));
    list = same ? list.map((x) => (x === same ? decisionEntry(d, same.id) : x)) : addDecision(list, decisionEntry(d, decisionId(d, list)));
  }
  return list;
}

function questionList(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const q of list.map((x) => oneLine(x, MAX_LINE)).filter(Boolean)) if (!out.some((x) => sameText(x, q))) out.push(q);
  return out.slice(0, MAX_DECISIONS);
}

/** The body with its decisions and open questions as given (none: the fields go). */
function withNotes(body: PlanBody, decisions: readonly PlanDecisionEntry[], open: readonly string[]): PlanBody {
  const { decisions: _d, openQuestions: _q, ...rest } = body;
  return { ...rest, ...(decisions.length ? { decisions } : {}), ...(open.length ? { openQuestions: open } : {}) };
}

/** Changes, one after another; the result is checked as a whole. `repos`: the plan's now (its draft's repo changes go on top). */
export function applyOps(body: PlanBody, ops: readonly PlanOp[], repos?: readonly string[]): PlanBody {
  let next = body;
  for (const op of ops) next = applyOp(next, op, repos);
  return checkBody(prunedDecisions(next), repos && reposWith(repos, next.repoChanges));
}

/** Decisions only name tasks still in the plan (a task taken out leaves them). */
function prunedDecisions(body: PlanBody): PlanBody {
  if (!body.decisions?.length) return body;
  const ids = new Set(allTasks(body).map((t) => t.task.id));
  const decisions = body.decisions.map((d) => {
    if (!d.tasks?.some((id) => !ids.has(id))) return d;
    const { tasks, ...rest } = d;
    const kept = tasks!.filter((id) => ids.has(id));
    return kept.length ? { ...rest, tasks: kept } : rest;
  });
  return { ...body, decisions };
}

function applyOp(body: PlanBody, op: PlanOp, repos: readonly string[] | undefined): PlanBody {
  const milestoneIds = new Set(body.milestones.map((m) => m.id));
  const taskIds = new Set(allTasks(body).map((t) => t.task.id));
  const needMilestone = (id: string): PlanMilestone => {
    const m = body.milestones.find((x) => x.id === id);
    if (!m) throw new PlanError(`There's no milestone "${id}" (milestones: ${body.milestones.map((x) => x.id).join(', ') || 'none yet'})`);
    return m;
  };
  const needTask = (id: string): PlanTask => {
    const t = allTasks(body).find((x) => x.task.id === id)?.task;
    if (!t) throw new PlanError(`There's no task "${id}" in this plan`);
    return t;
  };
  const mapTasks = (fn: (t: PlanTask) => PlanTask | undefined): PlanBody => ({
    ...body,
    milestones: body.milestones.map((m) => ({ ...m, tasks: m.tasks.flatMap((t) => fn(t) ?? []) })),
  });
  switch (op.op) {
    case 'repo':
      return withRepo(body, op, repos);
    case 'decide': {
      const list = body.decisions ?? [];
      const made = decisionEntry(op.decision, decisionId(op.decision, list));
      return withNotes(body, addDecision(list, made), (body.openQuestions ?? []).filter((q) => !sameText(q, made.question)));
    }
    case 'open_question': {
      const q = oneLine(op.question ?? '', MAX_LINE);
      if (!q) throw new PlanError('Say the question');
      const rest = (body.openQuestions ?? []).filter((x) => !sameText(x, q));
      return withNotes(body, body.decisions ?? [], op.on ? questionList([...rest, q]) : rest);
    }
    case 'retitle': {
      const title = op.title !== undefined ? oneLine(op.title, MAX_TITLE) : body.title;
      if (!title) throw new PlanError('The plan needs a title');
      return { ...body, title, goal: op.goal !== undefined ? (block(op.goal, MAX_GOAL) ?? '') : body.goal };
    }
    case 'add_milestone': {
      const id = newId(op.milestone.id, op.milestone.title, milestoneIds, 'milestone', milestoneHolder(body));
      const tasks = (op.milestone.tasks ?? []).map((t) => task(t, newId(t.id, t.title, taskIds, 'task', taskHolder(body))));
      const made = milestone(op.milestone, id, tasks);
      const at = op.after ? body.milestones.findIndex((m) => m.id === op.after) : -2;
      if (op.after && at < 0) needMilestone(op.after);
      const list = [...body.milestones];
      list.splice(at === -2 ? list.length : at + 1, 0, made);
      return { ...body, milestones: list };
    }
    case 'update_milestone': {
      const m = needMilestone(op.id);
      const next = milestone(
        {
          title: op.title ?? m.title,
          ...((op.goal ?? m.goal) !== undefined ? { goal: op.goal ?? m.goal } : {}),
          criteria: op.criteria ?? m.criteria,
          ...(op.autonomy === null ? {} : (op.autonomy ?? m.autonomy) ? { autonomy: (op.autonomy ?? m.autonomy)! } : {}),
          ...(op.dependsOn === null ? {} : (op.dependsOn ?? m.dependsOn) ? { dependsOn: (op.dependsOn ?? m.dependsOn)! } : {}),
          ...(op.repos === null ? {} : (op.repos ?? m.repos) ? { repos: (op.repos ?? m.repos)! } : {}),
        },
        m.id,
        m.tasks,
      );
      return { ...body, milestones: body.milestones.map((x) => (x.id === m.id ? next : x)) };
    }
    case 'remove_milestone': {
      const m = needMilestone(op.id);
      const gone = new Set(m.tasks.map((t) => t.id));
      const rest = body.milestones.filter((x) => x.id !== m.id);
      return { ...body, milestones: rest.map((x) => ({ ...x, ...(x.dependsOn ? { dependsOn: x.dependsOn.filter((d) => d !== m.id) } : {}), tasks: x.tasks.map((t) => withoutRefs(t, gone)) })) };
    }
    case 'add_task': {
      const m = needMilestone(op.milestone);
      const made = task(op.task, newId(op.task.id, op.task.title, taskIds, 'task', taskHolder(body)));
      const at = op.after ? m.tasks.findIndex((t) => t.id === op.after) : -1;
      const tasks = [...m.tasks];
      tasks.splice(at >= 0 ? at + 1 : tasks.length, 0, made);
      return { ...body, milestones: body.milestones.map((x) => (x.id === m.id ? { ...x, tasks } : x)) };
    }
    case 'update_task': {
      const t = needTask(op.id);
      const p = op.patch;
      const merged: TaskInput = {
        title: p.title ?? t.title,
        goal: p.goal ?? t.goal,
        context: p.context ?? t.context,
        acceptance: p.acceptance ?? t.acceptance,
        blockedBy: p.blockedBy ?? t.blockedBy,
        parent: p.parent === null ? null : (p.parent ?? t.parent),
        ...((p.priority ?? t.priority) ? { priority: (p.priority ?? t.priority)! } : {}),
        estimate: p.estimate === null ? null : (p.estimate ?? t.estimate),
        ...((p.labels ?? t.labels) ? { labels: (p.labels ?? t.labels)! } : {}),
        ...((p.touches ?? t.touches) ? { touches: (p.touches ?? t.touches)! } : {}),
        ...((p.assignee ?? t.assignee) ? { assignee: (p.assignee ?? t.assignee)! } : {}),
        ...((p.decision ?? t.decision) ? { decision: (p.decision ?? t.decision)! } : {}),
        ...(p.issueId ? { issueId: p.issueId } : {}),
      };
      return mapTasks((x) => (x.id === t.id ? task(merged, t.id, t) : x));
    }
    case 'remove_task': {
      needTask(op.id);
      const gone = new Set([op.id]);
      return mapTasks((x) => (x.id === op.id ? undefined : withoutRefs(x, gone)));
    }
    case 'move_task': {
      const t = needTask(op.id);
      needMilestone(op.milestone);
      // Its sub-tasks go with it (a sub-task stays in its parent's milestone).
      const family = new Set([t.id, ...descendants(body, t.id)]);
      const moving = allTasks(body)
        .filter((x) => family.has(x.task.id))
        .map((x) => x.task);
      const without = body.milestones.map((m) => ({ ...m, tasks: m.tasks.filter((x) => !family.has(x.id)) }));
      return {
        ...body,
        milestones: without.map((m) => {
          if (m.id !== op.milestone) return m;
          const at = op.before ? m.tasks.findIndex((x) => x.id === op.before) : -1;
          const tasks = [...m.tasks];
          tasks.splice(at >= 0 ? at : tasks.length, 0, ...moving);
          return { ...m, tasks };
        }),
      };
    }
    case 'block': {
      const t = needTask(op.id);
      needTask(op.by);
      const blockedBy = op.on ? [...new Set([...t.blockedBy, op.by])] : t.blockedBy.filter((b) => b !== op.by);
      return mapTasks((x) => (x.id === t.id ? { ...x, blockedBy } : x));
    }
    case 'update_decision': {
      const list = body.decisions ?? [];
      const was = list.find((d) => d.id === op.id);
      if (!was) throw new PlanError(`There's no decision "${op.id}" (decisions: ${list.map((d) => d.id).join(', ') || 'none yet'})`);
      const next = decisionEntry(
        {
          question: op.question ?? was.question,
          answer: op.answer ?? was.answer,
          by: was.by,
          ...((op.why ?? was.why) ? { why: (op.why ?? was.why)! } : {}),
          ...((op.tasks ?? was.tasks) ? { tasks: (op.tasks ?? was.tasks)! } : {}),
          ...(op.terms ? { terms: op.terms } : {}),
          ...(op.retires ? { retires: op.retires } : {}),
        },
        was.id,
        was,
      );
      return { ...body, decisions: list.map((d) => (d.id === was.id ? next : d)) };
    }
    case 'remove_decision': {
      const list = body.decisions ?? [];
      if (!list.some((d) => d.id === op.id)) throw new PlanError(`There's no decision "${op.id}" (decisions: ${list.map((d) => d.id).join(', ') || 'none yet'})`);
      // The one it had replaced is in force again; one that replaced it stands on its own.
      const rest = list
        .filter((d) => d.id !== op.id)
        .map((d) => {
          if (d.supersededBy === op.id) {
            const { supersededBy: _s, ...kept } = d;
            return kept;
          }
          if (d.supersedes === op.id) {
            const { supersedes: _s, ...kept } = d;
            return kept;
          }
          return d;
        });
      const { decisions: _d, ...without } = body;
      return rest.length ? { ...body, decisions: rest } : without;
    }
  }
}

const withoutRefs = (t: PlanTask, gone: ReadonlySet<string>): PlanTask => {
  const next: PlanTask = { ...t, blockedBy: t.blockedBy.filter((b) => !gone.has(b)) };
  if (t.parent && gone.has(t.parent)) {
    const { parent: _p, ...rest } = next;
    return rest;
  }
  return next;
};

function descendants(body: PlanBody, id: string): string[] {
  const out: string[] = [];
  const all = allTasks(body).map((t) => t.task);
  const walk = (at: string): void => {
    for (const t of all) {
      if (t.parent === at && !out.includes(t.id)) {
        out.push(t.id);
        walk(t.id);
      }
    }
  };
  walk(id);
  return out;
}

/** The rules a plan keeps (a clear message for Claude when one is broken). `repos`: the plan's, its milestones must stay within them. */
export function checkBody(body: PlanBody, repos?: readonly string[]): PlanBody {
  if (repos) checkMilestoneRepos(body, repos);
  const tasks = allTasks(body);
  const mids = new Set<string>();
  for (const m of body.milestones) {
    if (mids.has(m.id)) throw new PlanError(`Two milestones are called "${m.id}"`);
    // What it builds on comes before it (so milestones never wait on each other in a loop).
    for (const d of m.dependsOn ?? []) {
      if (d === m.id) throw new PlanError(`Milestone "${m.id}" can't depend on itself`);
      if (!mids.has(d)) throw new PlanError(body.milestones.some((x) => x.id === d) ? `Milestone "${m.id}" depends on "${d}", which comes after it: move one of them, or drop it from depends_on` : `Milestone "${m.id}" depends on "${d}", which isn't in the plan (milestones: ${body.milestones.map((x) => x.id).join(', ')})`);
    }
    mids.add(m.id);
  }
  const where = new Map<string, number>();
  for (const { task: t, index } of tasks) {
    if (where.has(t.id)) throw new PlanError(`Two tasks are called "${t.id}"`);
    where.set(t.id, index);
  }
  const byId = new Map(tasks.map((x) => [x.task.id, x]));
  for (const { task: t, index } of tasks) {
    for (const b of t.blockedBy) {
      if (b === t.id) throw new PlanError(`"${t.id}" can't wait on itself`);
      const at = where.get(b);
      if (at === undefined) throw new PlanError(`"${t.id}" waits on "${b}", which isn't in the plan (tasks: ${[...where.keys()].slice(0, 30).join(', ')})`);
      if (at > index) throw new PlanError(`"${t.id}" waits on "${b}" in a later milestone: move one of them, or drop the blocker`);
    }
    if (t.parent) {
      const parent = byId.get(t.parent);
      if (!parent) throw new PlanError(`"${t.id}" is a sub-task of "${t.parent}", which isn't in the plan`);
      if (parent.index !== index) throw new PlanError(`"${t.id}" and its parent "${t.parent}" must be in the same milestone`);
    }
  }
  // No loops: of blockers, nor of parents.
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new PlanError(`These tasks wait on each other in a loop: ${[...path.slice(path.indexOf(id)), id].join(' → ')}`);
    state.set(id, 1);
    for (const b of byId.get(id)?.task.blockedBy ?? []) visit(b, [...path, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  for (const d of body.decisions ?? []) for (const id of d.tasks ?? []) if (!byId.has(id)) throw new PlanError(`The decision “${d.question}” names task "${id}", which isn't in the plan`);
  for (const { task: t } of tasks) {
    const seen = new Set([t.id]);
    for (let at = t.parent; at; at = byId.get(at)?.task.parent) {
      if (seen.has(at)) throw new PlanError(`"${t.id}" is its own sub-task`);
      seen.add(at);
    }
  }
  return body;
}

export function checkMilestoneRepos(body: PlanBody, repos: readonly string[]): void {
  for (const m of body.milestones) {
    const outside = (m.repos ?? []).filter((r) => !repos.includes(r));
    if (!outside.length) continue;
    const named = outside.map((r) => `"${r}"`).join(', ');
    throw new PlanError(`Milestone "${m.id}" works in ${named}, which ${outside.length > 1 ? "aren't" : "isn't"} one of this plan's repos (repos: ${repos.join(', ')}): pick from those, or leave repos out for the primary`);
  }
}
