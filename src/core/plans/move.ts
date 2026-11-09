import type { CarriedFile, Issue } from '../board/model.js';
import type { LogItem } from '../store.js';
import { type MilestoneRun, type Plan, type PlanBody, type PlanMove, allTasks } from './model.js';
import type { PlanView } from './progress.js';

/**
 * A plan moving to another computer (BLG-806), as the daemons see it. The old computer packs it:
 * the plan (its draft and approved body, its runs and activity), its conversation, its board tasks
 * and their proof files, and the branches its work is on. The new one unpacks it into the matching
 * project there, made ready to carry on: the plan's next agents start there, each open milestone
 * from the branch its agent left. Your app moves it (src/machines/move-plan.ts); the old copy is
 * only archived once the new one is in. Browser-safe.
 */

export interface PlanPackage {
  readonly version: 1;
  readonly plan: Plan;
  /** Its conversation: what it's called and what was said there. */
  readonly home: { readonly name: string; readonly items: readonly LogItem[] };
  /** Its board tasks (its own and its epics). */
  readonly issues: readonly Issue[];
  /** Their proof files that came along (by proof id). */
  readonly files: Readonly<Record<string, CarriedFile>>;
  /** The project it's in, as the other computer finds it (by origin, else by name). */
  readonly project: { readonly name: string; readonly origin?: string };
  /** The branches its work is on, and how they travel: pushed to origin, or in a bundle (base64). */
  readonly git?: PlanBranches;
}

export type PlanBranches = { readonly branches: readonly string[]; readonly via: 'origin' } | { readonly branches: readonly string[]; readonly via: 'bundle'; readonly bundle: string };

/** Whether a plan can move now, and what to ask first. */
export interface MoveCheck {
  /** Why it can't move at all right now, in words (none: it can). */
  readonly blocked?: string;
  /** What's at work in it right now, in words: Pause and Move waits for these to finish their turn. */
  readonly running: readonly string[];
  /** Worktrees of it with changes not committed (task keys, or milestone titles): asked about first. */
  readonly dirty: readonly string[];
  readonly paused: boolean;
  readonly project: { readonly name: string; readonly origin?: string };
}

/** Why a plan can't move at all now (none: it can, once nothing runs). */
export function moveBlocked(plan: Plan): string | undefined {
  if (plan.movedTo) return `It moved to ${plan.movedTo.name} already`;
  if (plan.status === 'done') return 'It’s finished: there’s nothing left to run elsewhere';
  const merging = Object.keys(plan.merging ?? {})[0];
  if (merging) return `“${titleOf(plan, merging)}” is merging into the plan’s branch: move it once that’s done`;
  if (plan.mainMerge) return 'Main is being merged into the plan’s branch: move it once that’s done';
  if (Object.keys(plan.combining ?? {}).length) return 'A task’s start is being combined from several branches: move it once that’s done';
  return undefined;
}

/** What's at work in a plan now, in words (its milestones' agents, its checks, its own agent). */
export function moveRunning(view: PlanView, busy: (channel: string) => boolean): string[] {
  const out: string[] = [];
  if (busy(view.plan.home)) out.push('the plan’s agent');
  for (const m of view.milestones) {
    if (m.agentNow) out.push(`the agent doing “${m.milestone.title}”`);
    for (const t of m.tasks) if ((t.state === 'running' || t.state === 'asking') && t.worktree !== m.agent?.worktree) out.push(t.issue?.key ?? `“${t.task.title}”`);
    const checker = m.run.checker;
    if (checker && !m.run.passedAt && busy(`ws:${checker}`)) out.push(`the check of “${m.milestone.title}”`);
  }
  return [...new Set(out)];
}

/** The board tasks a plan takes along: every task of its approved body and its draft, and its epics. */
export function planIssueIds(plan: Plan): string[] {
  const ids = [...allTasks(plan.body), ...allTasks(plan.draft)].flatMap((t) => (t.task.issueId ? [t.task.issueId] : []));
  const epics = plan.epics ? [plan.epics.plan, ...Object.values(plan.epics.milestones)] : [];
  return [...new Set([...ids, ...epics])];
}

/** The branches a plan's work is on: its own, and those of its milestones not passed yet (their agents', their tasks'). */
export function planBranches(plan: Plan, issues: readonly Issue[]): string[] {
  const open = (plan.body?.milestones ?? []).filter((m) => !plan.runs[m.id]?.passedAt);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const out = [plan.branch, ...open.map((m) => plan.runs[m.id]?.agent?.branch), ...open.flatMap((m) => m.tasks.map((t) => (t.issueId ? byId.get(t.issueId)?.branch : undefined)))];
  return [...new Set(out.filter((b): b is string => Boolean(b)))];
}

export interface Landing {
  readonly projectId: string;
  /** Its conversation here (`ws:<id>`). */
  readonly home: string;
  /** Old task id → id here. */
  readonly ids: ReadonlyMap<string, string>;
  /** The branches that came along. */
  readonly branches: readonly string[];
  readonly from: PlanMove;
  readonly by: Plan['activity'][number]['by'];
}

/**
 * The plan as it lands on the new computer: in its project and conversation there, linked to its
 * tasks there, paused until the move is done (your app resumes it if it ran). What only meant
 * something on the old computer goes: its agents' and checkers' conversations, a stall's wake, the
 * rescue ladder. An open milestone's next agent starts from the branch its agent left.
 */
export function landPlan(plan: Plan, to: Landing): Plan {
  const id = (issueId: string | undefined): string | undefined => (issueId ? (to.ids.get(issueId) ?? issueId) : undefined);
  const relink = (body: PlanBody | undefined): PlanBody | undefined =>
    body ? { ...body, milestones: body.milestones.map((m) => ({ ...m, tasks: m.tasks.map((t) => (t.issueId ? { ...t, issueId: id(t.issueId)! } : t)) })) } : undefined;
  const carried = new Set(to.branches);
  const runs = Object.fromEntries(
    Object.entries(plan.runs).map(([mid, run]) => {
      const { agent, checker: _c, checkAsked, check, mergeFailed: _f, resumeFrom, ...rest } = run;
      // A check that was asked and not answered is asked again there; one that was answered stays.
      const answered = check && checkAsked !== undefined && check.at >= checkAsked;
      const from = !run.passedAt ? (agent?.branch && carried.has(agent.branch) ? agent.branch : resumeFrom) : undefined;
      const next: MilestoneRun = { ...rest, ...(answered ? { check, checkAsked } : {}), ...(from ? { resumeFrom: from } : {}) };
      return [mid, next];
    }),
  );
  const body = relink(plan.body);
  const draft = relink(plan.draft);
  const epics = plan.epics ? { plan: id(plan.epics.plan)!, milestones: Object.fromEntries(Object.entries(plan.epics.milestones).map(([k, v]) => [k, id(v)!])) } : undefined;
  const { combining: _co, watch: _w, merging: _m, mainMerge: _mm, rescue: _r, movedTo: _t, ...rest } = plan;
  return {
    ...rest,
    projectId: to.projectId,
    home: to.home,
    ...(body ? { body } : {}),
    ...(draft ? { draft } : {}),
    ...(epics ? { epics } : {}),
    runs,
    paused: true,
    movedFrom: to.from,
    activity: [...plan.activity, { id: `e_moved_${to.from.at}`, at: to.from.at, by: to.by, kind: 'note' as const, text: `moved the plan here from ${to.from.name}` }].slice(-200),
  };
}

/** Its conversation as it lands: the same items in the new channel, and a line saying where it came from. */
export function landHistory(items: readonly LogItem[], from: string, to: string, fromName: string, at: number): LogItem[] {
  return [
    ...items.map((l) => (l.channel === from ? ({ ...l, channel: to } as LogItem) : l)),
    { id: `moved-${at}`, type: 'system', channel: to, text: `This plan moved here from ${fromName}. Its agent here starts fresh with the plan and this conversation.`, ts: at, level: 'info' } as LogItem,
  ];
}

function titleOf(plan: Plan, milestone: string): string {
  return (plan.body ?? plan.draft)?.milestones.find((m) => m.id === milestone)?.title ?? milestone;
}
