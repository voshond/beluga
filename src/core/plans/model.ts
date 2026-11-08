import type { AgentRef } from '../../protocol.js';
import type { Actor, IssuePr, Priority } from '../board/model.js';

/**
 * Plans: a goal cut into milestones, each with tasks and the criteria that say it's passed.
 * Claude writes a plan in a conversation (its home); until you approve it, the plan is only a
 * draft there and never touches Tasks. Approving puts its tasks on the board, and the plan then
 * runs its milestones (side by side where none builds on another), as far on its own as its
 * autonomy allows.
 * Browser-safe: the Mac app runs it. See docs/tasks-and-plans.md.
 */

export const AUTONOMIES = ['step', 'gated', 'autopilot'] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

/**
 * What each autonomy is called everywhere (the Mac app, Claude's prompt): `label` its name,
 * `summary` the one sentence a choice of it shows, `hint` the longer how-it-runs.
 */
export const AUTONOMY_INFO: Readonly<Record<Autonomy, { readonly label: string; readonly summary: string; readonly hint: string }>> = {
  step: { label: 'Step by Step', summary: 'You start each task', hint: 'Your agent lines up what can start; you start each task' },
  gated: { label: 'Check-ins', summary: 'Runs, then waits for you at each milestone', hint: 'Tasks start by themselves; each milestone waits for you to pass it' },
  autopilot: { label: 'Autopilot', summary: 'Runs to the end, stops only if something fails', hint: 'Milestone to milestone on its own: your agent checks each one; it stops only when something fails' },
};

/** When a plan runs its e2e and full test suites: once per milestone at its check, or only at the end. */
export const TESTS_AT = ['milestone', 'end'] as const;
export type TestsAt = (typeof TESTS_AT)[number];

export const TESTS_AT_INFO: Readonly<Record<TestsAt, { readonly label: string; readonly hint: string }>> = {
  milestone: { label: 'Each Milestone', hint: 'Tasks run typecheck and the tests they touched; each milestone’s check runs the full suites once' },
  end: { label: 'Only at the End', hint: 'Milestone checks read the code and diffs; the full suites run once, in the final step' },
};

/** A new plan's autonomy. */
export const DEFAULT_AUTONOMY: Autonomy = 'gated';

/** One task of a plan, before and after it's on the board. */
export interface PlanTask {
  /** Stable inside the plan ("auth-api"): Claude names tasks by it, and it survives re-planning. */
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  readonly context?: string;
  /** Done means all of these are true. */
  readonly acceptance: readonly string[];
  /** Tasks of this plan that must be finished first (ids). */
  readonly blockedBy: readonly string[];
  /** A sub-task's parent (an id in the same milestone). */
  readonly parent?: string;
  readonly priority?: Priority;
  readonly estimate?: number;
  readonly labels?: readonly string[];
  /** Files or areas it changes: tasks that run side by side shouldn't share them. */
  readonly touches?: readonly string[];
  /** Who works on it: your Claude (the default) or you. */
  readonly assignee?: 'claude' | 'me';
  /** Yours (assignee "me"): what you're asked when it's ready, in the plan's conversation (see decisions.ts). */
  readonly decision?: PlanDecision;
  /** Its task on the board, once the plan is approved. */
  readonly issueId?: string;
}

/**
 * A milestone's Claude asking you something while it works (plan_ask, BLG-6): a structured question,
 * never buried in its prose. Beluga asks you in the plan's conversation (and on the phone), the Claude
 * goes on with what doesn't need it, and your answer goes on the task and back to it.
 */
export interface PlanAsk {
  /** The plan task it's about (its id in the plan). */
  readonly task: string;
  readonly question: string;
  /** Why it matters, in a sentence (shown under the question). */
  readonly why?: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  /** The option it recommends (a label of one of them): shown first, marked Recommended. */
  readonly recommended?: string;
  readonly multi?: boolean;
  /** What it needs you to run (sudo, a deploy, a login on another machine): shown as commands to copy. */
  readonly run?: PlanRun;
  /** The worktree that asked (workspace id): the answer goes there. */
  readonly worktree: string;
  readonly at: number;
}

/** A plan task that's yours, as a choice: the question, the options (pick one, or several), and always your own words. */
export interface PlanDecision {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  readonly multi?: boolean;
  /** What you run to do it, when it's a step on a machine (sudo, a deploy): never just "have you done it?". */
  readonly run?: PlanRun;
}

/**
 * Commands you're asked to run yourself: where (the machine, the folder: worktrees move, so it's
 * always a full path), exactly what to type, and what you see when it worked. The card shows them
 * as a block to copy, so "done?" is never asked without the how.
 */
export interface PlanRun {
  /** The machine ("i9arch", "the NAS"); left out, this one. */
  readonly on?: string;
  /** The folder to run them in (a full path). */
  readonly cwd?: string;
  readonly commands: readonly string[];
  /** What it prints, or what's true, when it worked. */
  readonly expect?: string;
}

export const MAX_RUN_COMMANDS = 12;

/** Commands as given: trimmed and capped; none without a command. */
export function runOf(input: { readonly on?: string; readonly cwd?: string; readonly commands?: readonly string[] | string; readonly expect?: string } | undefined): PlanRun | undefined {
  if (!input?.commands) return undefined;
  const raw = typeof input.commands === 'string' ? input.commands.split('\n') : input.commands;
  const commands = raw.map((c) => c.trimEnd().slice(0, 400)).filter((c) => c.trim()).slice(0, MAX_RUN_COMMANDS);
  if (!commands.length) return undefined;
  const on = input.on?.replace(/\s+/g, ' ').trim().slice(0, 80);
  const cwd = input.cwd?.trim().slice(0, 300);
  const expect = input.expect?.replace(/\s+/g, ' ').trim().slice(0, 300);
  return { ...(on ? { on } : {}), ...(cwd ? { cwd } : {}), commands, ...(expect ? { expect } : {}) };
}

export interface PlanMilestone {
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  /** Pass criteria: what must be true to call the milestone done (checked by Claude, passed by you or Claude). */
  readonly criteria: readonly string[];
  readonly tasks: readonly PlanTask[];
  /** This milestone's own autonomy (else the plan's). */
  readonly autonomy?: Autonomy;
  /**
   * Earlier milestones it builds on (ids): it opens once they've passed. Left out, it's inferred
   * from its tasks' blockers in other milestones; empty, it runs alongside from the start.
   */
  readonly dependsOn?: readonly string[];
  /** The repos it works in (project ids, from the plan's): absent or empty, the plan's primary. */
  readonly repos?: readonly string[];
}

/**
 * One thing settled while planning (BLG-8): what was asked, what was decided and why. `user`: you
 * answered it; `default`: Claude chose it without asking (a sensible default you can override
 * before approving). `tasks`: the plan tasks it bears on, whose briefs get it.
 */
export interface PlanDecisionEntry {
  readonly question: string;
  readonly answer: string;
  readonly why?: string;
  readonly by: 'user' | 'default';
  readonly tasks?: readonly string[];
}

/**
 * A repo the draft adds to the plan or drops from it (BLG-29), with why: Claude's suggestion (it
 * found the work reaches that repo, or doesn't) or yours (you tagged it). Approving applies them.
 */
export interface PlanRepoChange {
  /** The project id. */
  readonly repo: string;
  readonly change: 'add' | 'drop';
  readonly why?: string;
  readonly by: 'claude' | 'user';
}

/** What a plan says: the part Claude writes and you approve. */
export interface PlanBody {
  readonly title: string;
  readonly goal: string;
  readonly milestones: readonly PlanMilestone[];
  /** What was settled while planning: your answers and Claude's defaults (BLG-8). Every agent on the plan reads them. */
  readonly decisions?: readonly PlanDecisionEntry[];
  /** What's still to be settled: the plan can't be approved while one is open. */
  readonly openQuestions?: readonly string[];
  /** A draft's changes to the plan's repos (never on an approved body: approving applies them to `Plan.repos`). */
  readonly repoChanges?: readonly PlanRepoChange[];
}

/** The plan's decisions that bear on one task, as lines for its brief's Decisions. */
export function decisionLines(body: PlanBody | undefined, taskId: string): string[] {
  return (body?.decisions ?? []).filter((d) => d.tasks?.includes(taskId)).map((d) => `- ${d.question} → ${d.answer}${d.by === 'default' ? ' (a default, not asked)' : ''}${d.why ? ` — ${d.why}` : ''}`);
}

/** Claude's check of a milestone's pass criteria. */
export interface GateCheck {
  readonly at: number;
  readonly by: Actor;
  readonly verdict: 'pass' | 'fail';
  readonly notes: string;
}

/** How a milestone is going (by milestone id). */
export interface MilestoneRun {
  readonly passedAt?: number;
  readonly passedBy?: Actor;
  /** Claude's latest check of its criteria. */
  readonly check?: GateCheck;
  /** When the head Claude was asked to check it (asked once per round). */
  readonly checkAsked?: number;
  /** The one Claude doing its tasks, in one worktree (see pilot.ts). */
  readonly agent?: MilestoneAgent;
  /**
   * The conversation that checks it (a workspace id): a Claude of its own, not the head's, so the
   * plan's conversation stays free while it checks and milestones are checked side by side.
   */
  readonly checker?: string;
  /** Passing it couldn't merge its tasks into the plan's branch (not a conflict: a dirty checkout, no git identity): why, until it's passed again. */
  readonly mergeFailed?: { readonly at: number; readonly reason: string };
}

/**
 * A milestone's own Claude: one worktree that does the milestone's tasks one after another (in
 * the order they build on each other), keeping what it learned. Each task links the worktree, and
 * its Claude moves each one along on the board (In Progress, then In Review with its proof).
 */
export interface MilestoneAgent {
  /** The worktree (workspace id) and its branch. */
  readonly worktree: string;
  readonly branch?: string;
  readonly at: number;
  /** Plan task ids handed to it so far (more come when a check adds fix tasks). */
  readonly tasks: readonly string[];
  /** A milestone across repos: its worktrees in the other repos (it edits them too), each merged into its repo's plan branch. */
  readonly along?: readonly MilestoneAlong[];
}

/** A milestone agent's worktree in one of its other repos. */
export interface MilestoneAlong {
  readonly projectId: string;
  readonly worktree: string;
  readonly branch?: string;
}

/** A task that builds on several unmerged tasks: their branches are being combined into its start. */
export interface Combining {
  readonly at: number;
  /** The tasks it builds on (their keys, e.g. KLD-9). */
  readonly from: readonly string[];
  /** It stopped at a conflict, left in a hidden worktree for the head Claude to fix. */
  readonly conflict?: {
    readonly at: number;
    readonly dir: string;
    readonly merging: string;
    readonly files: readonly string[];
    /** Claude was asked and it's still there: it waits for you. */
    readonly stuck?: boolean;
  };
}

/** Main merged into the plan's branch (its PR conflicts with main): in the hidden worktree, a conflict there fixed by the plan's Claude. */
export interface PlanMainMerge {
  readonly at: number;
  /** What was merged in ("origin/main"). */
  readonly main: string;
  readonly projectId?: string;
  readonly conflict?: {
    readonly at: number;
    readonly dir: string;
    readonly files: readonly string[];
    /** Claude was asked and it's still there: it waits for you. */
    readonly stuck?: boolean;
  };
}

/** The plan's pull request as GitHub last showed it: what stands in the way of merging it too. */
export interface PlanPr extends IssuePr {
  /** GitHub says it conflicts with main. */
  readonly conflicts?: boolean;
  /** Auto-merge is on: GitHub merges it once its checks and reviews pass. */
  readonly autoMerge?: boolean;
  /** Behind main (main needs merging in first), or blocked by main's rules. */
  readonly mergeState?: 'behind' | 'blocked';
}

/**
 * A passed milestone's task branches being merged (--no-ff) into the plan's branch, in a hidden
 * worktree. The milestone counts as passed once that's done; a conflict goes to the head Claude.
 */
export interface PlanMerge {
  readonly at: number;
  /** Who passed it. */
  readonly by: Actor;
  /** It had passed before the plan had a branch (catching up): it isn't passed again. */
  readonly catchUp?: boolean;
  readonly conflict?: {
    readonly at: number;
    readonly dir: string;
    /** The branch that conflicted, and its task's key. */
    readonly merging: string;
    readonly key?: string;
    /** The repo it conflicts in (project id); absent, the plan's primary. */
    readonly projectId?: string;
    readonly files: readonly string[];
    /** Claude was asked and it's still there: it waits for you. */
    readonly stuck?: boolean;
  };
}

/**
 * A started task whose Claude stopped without finishing (see watchdog.ts): the latest stall, and
 * what Beluga did about it. Woken once; stalling again soon after, it waits for you.
 */
export interface TaskWatch {
  /** When it was last seen stalled, and why (“it ended its turn without handing off”). */
  readonly at: number;
  readonly reason: string;
  /** The run it stalled on (its request id): one run is one stall. */
  readonly run?: string;
  /** When Beluga woke it (or you resumed it). */
  readonly wokeAt?: number;
  /** It stalled again soon after a wake: it waits for you (Resume, or Open Chat). */
  readonly needsYou?: boolean;
  /** The one line it's shown with: “KLD-36 stopped, woke it at 11:13”. */
  readonly line: string;
  /** Stopped by your usage limit: when it goes on by itself (see shared/run-failure.ts). */
  readonly limitUntil?: number;
  /** The run it was resumed from after the limit reset (so it's resumed once). */
  readonly resumed?: string;
}

/** The plan reached main: through its pull request, or merged here. */
export interface PlanShipped {
  readonly at: number;
  readonly how: 'pr' | 'local';
  readonly number?: number;
}

/**
 * What a plan's activity records. `started`/`finished`: a task began / came back for review;
 * `gate`: Claude was asked to check a milestone, `checked`: its check passed (`failed`: it didn't);
 * `merged`: a milestone's work went into the plan's branch; `autonomy`: the run mode changed.
 */
export type PlanEventKind = 'created' | 'drafted' | 'approved' | 'changed' | 'started' | 'finished' | 'gate' | 'checked' | 'merged' | 'passed' | 'failed' | 'autonomy' | 'paused' | 'resumed' | 'done' | 'note' | 'problem';

export interface PlanEvent {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly kind: PlanEventKind;
  readonly text: string;
}

export type PlanStatus = 'draft' | 'active' | 'done';

export interface Plan {
  readonly id: string;
  /** Its primary repo. */
  readonly projectId: string;
  /** Every repo it covers (project ids, primary first); absent, only projectId. */
  readonly repos?: readonly string[];
  /** A plan across repos: the board its tasks go on (one covering its repos, BLG-12); absent, each repo's own. */
  readonly board?: string;
  /** The conversation it's planned and run from (`ws:<id>`): its head Claude. */
  readonly home: string;
  readonly status: PlanStatus;
  /**
   * What you asked for, in your own words (BLG-3): the New Plan box, or what you said in its
   * conversation before it was first approved. Never rewritten by Claude, and handed in full to
   * every milestone's Claude and checker, so nothing is lost between handoffs.
   */
  readonly request?: string;
  /** What was approved (its tasks are on the board). */
  readonly body?: PlanBody;
  /** Claude's (and your) working copy, not on the board: a new plan, or changes to an approved one. */
  readonly draft?: PlanBody;
  /** Bumped by every change to the draft (screens and Claude see it moved). */
  readonly draftRev: number;
  readonly autonomy: Autonomy;
  /** How many of its tasks may run at once. */
  readonly maxParallel: number;
  /** When the e2e and full test suites run (tasks only run typecheck and the tests they touched). */
  readonly testsAt: TestsAt;
  /** The agent (and model) its milestones and tasks are worked on by (BLG-497); none: your default. A task's own agent beats it. */
  readonly agent?: AgentRef;
  readonly paused: boolean;
  readonly runs: Readonly<Record<string, MilestoneRun>>;
  /** Tasks whose start is being combined from several branches (by plan task id). */
  readonly combining?: Readonly<Record<string, Combining>>;
  /** Started tasks that stalled, and the wake or the stop that followed (by plan task id). */
  readonly watch?: Readonly<Record<string, TaskWatch>>;
  /** Its branch (plan/<slug>, from main): every task starts from it, passed milestones merge into it, and it ends as one PR. */
  readonly branch?: string;
  /** A plan across repos: each repo's plan/<slug> (by project id; the primary's is `branch` too). Absent: only `branch`, in the primary. */
  readonly branches?: Readonly<Record<string, string>>;
  /** Passed milestones being merged into the branch (by milestone id). */
  readonly merging?: Readonly<Record<string, PlanMerge>>;
  /** Main being merged into the plan's branch (its PR conflicted with main), or stopped at a conflict for Claude to fix. */
  readonly mainMerge?: PlanMainMerge;
  /** The branch's pull request into main, as last seen. */
  readonly pr?: PlanPr;
  readonly prs?: Readonly<Record<string, PlanPr>>;
  readonly shipped?: PlanShipped;
  readonly shippedIn?: Readonly<Record<string, PlanShipped>>;
  readonly mergeAll?: { readonly at: number; readonly auto: boolean };
  /** Plans that ran before they had a branch were caught up once (passed milestones merged into one). */
  readonly caughtUp?: boolean;
  /**
   * The conversation fixing its merge conflicts (a workspace id, BLG-4): a Claude of its own, not
   * the head's, so the plan's conversation never fills up with code work. Archived once no conflict is left.
   */
  readonly fixer?: string;
  /** Questions its Claudes asked you that wait for an answer, by plan task id (one per task: a new one replaces it). */
  readonly asks?: Readonly<Record<string, PlanAsk>>;
  /** Its shape on the board: an epic for the plan, one under it per milestone (see epics.ts). */
  readonly epics?: PlanEpics;
  /** Beluga moving its stalled milestones along (see the pilot's rescue), by milestone id: kept, so a restart doesn't start over. */
  readonly rescue?: Readonly<Record<string, PlanRescue>>;
  readonly activity: readonly PlanEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly doneAt?: number;
}

/**
 * A plan with nothing running and nothing waiting on you is stalled: Beluga moves it along, a step
 * further each time the same thing stays stuck (send it on, a fresh Claude, the head Claude decides),
 * and only then tells you, saying what it tried.
 */
export interface PlanRescue {
  /** How far the milestone had got (see milestoneMark): moving on from there starts the ladder over. */
  readonly sig: string;
  /** What it's stuck on now (a check, stopped tasks, idle work…): a new kind starts its ladder over. */
  readonly kind?: string;
  /** How many steps up the ladder it has gone for that kind. */
  readonly tries: number;
  /** Steps taken in all, across kinds: past a few, it's yours (no going round in circles). */
  readonly total?: number;
  readonly at: number;
  /** What was tried, in words (shown when it's left to you). */
  readonly tried: readonly string[];
  /** Left to you: nothing more is tried until something moves. */
  readonly yours?: boolean;
}

/**
 * A plan's epics on the board (task ids): the plan's own, and each milestone's (by milestone id). A
 * plan across repos on its repos' own boards (BLG-34) has the plan's epic once per repo: `plan` on the
 * primary's board, `repos` on each other repo's (by project id), each milestone's epic under its repo's.
 */
export interface PlanEpics {
  readonly plan: string;
  readonly milestones: Readonly<Record<string, string>>;
  readonly repos?: Readonly<Record<string, string>>;
}

export interface PlansState {
  /** Plans run (the Mac app's daemon); off elsewhere. */
  readonly enabled: boolean;
  readonly plans: readonly Plan[];
  /** Your planning style: how you like plans cut (added to Claude's planning instructions). */
  readonly style: string;
}

export interface PlansSlice {
  readonly plans: PlansState;
}

export const KEEP_PLAN_ACTIVITY = 200;
<<<<<<< HEAD
/** How much of what you asked for a plan keeps (your first words, then what you added while planning). */
export const MAX_REQUEST = 8000;
export const MAX_MILESTONES = 12;
export const MAX_PLAN_TASKS = 80;
=======
>>>>>>> upstream/main
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 8;
export const MAX_PLAN_REPOS = 8;

export const NO_PLANS: PlansState = { enabled: false, plans: [], style: '' };
export const initialPlans: PlansSlice = { plans: NO_PLANS };

export type PlansAction =
  | { type: 'plans_init'; state: PlansState }
  | { type: 'plan_put'; plan: Plan }
  | { type: 'plan_remove'; id: string }
  | { type: 'plans_style'; style: string }
  | { type: 'plans_off' };

export const PLANS_ACTIONS: ReadonlySet<string> = new Set(['plans_init', 'plan_put', 'plan_remove', 'plans_style', 'plans_off']);

export function reducePlans(state: PlansSlice, action: PlansAction): PlansSlice {
  switch (action.type) {
    case 'plans_init':
      return { plans: action.state };
    case 'plan_put': {
      const list = state.plans.plans;
      const at = list.findIndex((p) => p.id === action.plan.id);
      return { plans: { ...state.plans, plans: at >= 0 ? list.map((p, n) => (n === at ? action.plan : p)) : [...list, action.plan] } };
    }
    case 'plan_remove':
      return { plans: { ...state.plans, plans: state.plans.plans.filter((p) => p.id !== action.id) } };
    case 'plans_style':
      return { plans: { ...state.plans, style: action.style } };
    case 'plans_off':
      return { plans: NO_PLANS };
    default:
      return state;
  }
}

// ---- for screens and Claude

export const planById = (state: PlansState, id: string): Plan | undefined => state.plans.find((p) => p.id === id);

/** The plan a conversation is the home of (the newest, when several were). */
export const planForHome = (state: PlansState, channel: string): Plan | undefined => [...state.plans].reverse().find((p) => p.home === channel);

/** The plan a board task stands for as an epic: the plan's own, or one of its milestones' (see epics.ts). */
export function planEpicOf(state: PlansState, issueId: string): { readonly plan: Plan; readonly milestone?: PlanMilestone } | undefined {
  for (const plan of state.plans) {
    if (!plan.epics) continue;
    if (plan.epics.plan === issueId || Object.values(plan.epics.repos ?? {}).includes(issueId)) return { plan };
    const id = Object.entries(plan.epics.milestones).find(([, epic]) => epic === issueId)?.[0];
    const milestone = id ? shownBody(plan)?.milestones.find((m) => m.id === id) : undefined;
    if (milestone) return { plan, milestone };
  }
  return undefined;
}

/** The plan whose merge conflicts a conversation fixes (see Plan.fixer). */
export function fixerOf(state: PlansState, channel: string): Plan | undefined {
  if (!channel.startsWith('ws:')) return undefined;
  const id = channel.slice(3);
  return state.plans.find((plan) => plan.fixer === id);
}

/** The plan and milestone a conversation checks (see MilestoneRun.checker). */
export function checkerOf(state: PlansState, channel: string): { readonly plan: Plan; readonly milestone: string } | undefined {
  if (!channel.startsWith('ws:')) return undefined;
  const id = channel.slice(3);
  for (const plan of state.plans) for (const [milestone, run] of Object.entries(plan.runs ?? {})) if (run?.checker === id) return { plan, milestone };
  return undefined;
}

/**
 * The conversation is a live plan's own (its head Claude plans and runs it there): it has no
 * Act/Plan modes, so plan mode is never switched there (Claude asking to approve a plan of its own
 * would stall the plan).
 */
export const isPlanHome = (state: PlansState, channel: string): boolean => {
  const plan = planForHome(state, channel);
  return Boolean(plan && plan.status !== 'done');
};

/** What a screen shows of a plan: the draft while there is one, else what was approved. */
export const shownBody = (plan: Plan): PlanBody | undefined => plan.draft ?? plan.body;

export const planTitle = (plan: Plan): string => shownBody(plan)?.title || 'New plan';

/** Every task of a body, with the milestone it's in. */
export function allTasks(body: PlanBody | undefined): Array<{ readonly task: PlanTask; readonly milestone: PlanMilestone; readonly index: number }> {
  return (body?.milestones ?? []).flatMap((milestone, index) => milestone.tasks.map((task) => ({ task, milestone, index })));
}

export const taskById = (body: PlanBody | undefined, id: string): PlanTask | undefined => allTasks(body).find((t) => t.task.id === id)?.task;

/** The plan task a board task came from. */
export function planTaskOfIssue(state: PlansState, issueId: string): { readonly plan: Plan; readonly task: PlanTask; readonly milestone: PlanMilestone } | undefined {
  for (const plan of state.plans) {
    const hit = allTasks(plan.body).find((t) => t.task.issueId === issueId);
    if (hit) return { plan, task: hit.task, milestone: hit.milestone };
  }
  return undefined;
}

export const planRepos = (plan: Pick<Plan, 'projectId' | 'repos'>): readonly string[] => [...new Set([plan.projectId, ...(plan.repos ?? [])])];

export const isMultiRepo = (plan: Pick<Plan, 'projectId' | 'repos'>): boolean => planRepos(plan).length > 1;

/** The repos `changes` make of `base` (primary first, and never dropped). */
export function reposWith(base: readonly string[], changes: readonly PlanRepoChange[] | undefined): readonly string[] {
  const dropped = new Set((changes ?? []).filter((c) => c.change === 'drop').map((c) => c.repo));
  const added = (changes ?? []).filter((c) => c.change === 'add').map((c) => c.repo);
  return [...new Set([...base.filter((r, i) => i === 0 || !dropped.has(r)), ...added])];
}

/** The repos a plan covers once its draft is approved: what the draft's milestones may name (BLG-29). */
export const proposedRepos = (plan: Pick<Plan, 'projectId' | 'repos' | 'draft'>): readonly string[] => reposWith(planRepos(plan), plan.draft?.repoChanges);

/** The plan's repos as its draft would make them: for what's drawn and checked while drafting. */
export const draftRepoPlan = (plan: Pick<Plan, 'projectId' | 'repos' | 'draft'>): Pick<Plan, 'projectId' | 'repos'> => ({ projectId: plan.projectId, repos: proposedRepos(plan) });

/** A repo's plan branch: its own, else (plans from before branches per repo) `branch` for the primary. */
export const planBranchFor = (plan: Pick<Plan, 'projectId' | 'branch' | 'branches'>, projectId: string): string | undefined =>
  plan.branches?.[projectId] ?? (projectId === plan.projectId ? plan.branch : undefined);

export function milestoneRepos(plan: Pick<Plan, 'projectId' | 'repos'>, milestone: Pick<PlanMilestone, 'repos'> | undefined): readonly string[] {
  const all = planRepos(plan);
  const named = (milestone?.repos ?? []).filter((r) => all.includes(r));
  return named.length ? [...new Set(named)] : [plan.projectId];
}

export const planPrFor = (plan: Pick<Plan, 'projectId' | 'pr' | 'prs'>, projectId: string): PlanPr | undefined =>
  plan.prs?.[projectId] ?? (projectId === plan.projectId ? plan.pr : undefined);

export const shippedIn = (plan: Pick<Plan, 'projectId' | 'repos' | 'shipped' | 'shippedIn'>, projectId: string): PlanShipped | undefined =>
  plan.shipped ?? plan.shippedIn?.[projectId];

export const prRef = (pr: Pick<PlanPr, 'number' | 'url'>): string => {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
  return m ? `${m[1]}/${m[2]}#${pr.number}` : `#${pr.number}`;
};

export function shipOrder(plan: Pick<Plan, 'projectId' | 'repos' | 'body'>): readonly string[] {
  const repos = planRepos(plan);
  const upstream = new Map(repos.map((r) => [r, new Set<string>()]));
  const milestones = plan.body?.milestones ?? [];
  const byId = new Map(milestones.map((m) => [m.id, m]));
  for (const m of milestones) {
    const here = milestoneRepos(plan, m);
    for (const dep of milestoneDeps(plan.body, m)) {
      for (const from of milestoneRepos(plan, byId.get(dep))) for (const to of here) if (from !== to) upstream.get(to)?.add(from);
    }
  }
  const order: string[] = [];
  while (order.length < repos.length) {
    const left = repos.filter((r) => !order.includes(r));
    order.push(left.find((r) => [...upstream.get(r)!].every((u) => order.includes(u))) ?? left[0]!);
  }
  const touched = new Set(milestones.flatMap((m) => milestoneRepos(plan, m)));
  return touched.size ? order.filter((r) => touched.has(r)) : [plan.projectId];
}

/** A milestone's own autonomy, else its plan's. */
export const autonomyOf = (plan: Plan, milestone: PlanMilestone | undefined): Autonomy => milestone?.autonomy ?? plan.autonomy;

/**
 * The milestones a milestone waits on (ids): what it says, else the milestones its tasks' blockers
 * are in (none: it runs alongside the others).
 */
export function milestoneDeps(body: PlanBody | undefined, milestone: PlanMilestone): readonly string[] {
  const ids = new Set((body?.milestones ?? []).map((m) => m.id));
  if (milestone.dependsOn) return milestone.dependsOn.filter((d) => d !== milestone.id && ids.has(d));
  const home = new Map(allTasks(body).map((t) => [t.task.id, t.milestone.id]));
  const out = new Set<string>();
  for (const t of milestone.tasks) {
    for (const b of t.blockedBy) {
      const m = home.get(b);
      if (m && m !== milestone.id) out.add(m);
    }
  }
  return (body?.milestones ?? []).map((m) => m.id).filter((id) => out.has(id));
}

/** Milestones being worked on now: not passed, and every one they wait on has passed (ids, in order). */
export function openMilestones(plan: Plan): readonly string[] {
  const body = plan.body;
  if (!body || plan.status === 'done') return [];
  const passed = (id: string): boolean => Boolean(plan.runs[id]?.passedAt);
  return body.milestones.filter((m) => !passed(m.id) && milestoneDeps(body, m).every(passed)).map((m) => m.id);
}

/**
 * The branch a plan's work collects on: a plan/<name> its text names (one kept by hand before),
 * else plan/ and its title up to a colon ("Beluga polish round: menus…" → plan/beluga-polish-round).
 */
export function planBranchName(plan: Plan): string {
  const body = plan.body ?? plan.draft;
  const named = /\bplan\/[A-Za-z0-9][\w.-]*[A-Za-z0-9]/.exec([body?.goal ?? '', ...(body?.milestones ?? []).flatMap((m) => [m.goal ?? '', ...m.criteria])].join('\n'))?.[0];
  if (named) return named;
  const title = (body?.title ?? '').split(':')[0]!;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `plan/${slug || plan.id.replace(/^pl_/, '').slice(0, 8)}`;
}

/** How a draft differs from what was approved: tasks added, changed and removed (by id). */
export interface PlanDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly milestones: number;
  /** Decisions and open questions added, changed or taken out (BLG-8). */
  readonly decisions: number;
  /** Repos the draft adds or drops (BLG-29). */
  readonly repos: number;
}

export function diffBodies(before: PlanBody | undefined, after: PlanBody | undefined): PlanDiff {
  const old = new Map(allTasks(before).map((t) => [t.task.id, t]));
  const now = new Map(allTasks(after).map((t) => [t.task.id, t]));
  const added = [...now.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !now.has(id));
  const changed = [...now.keys()].filter((id) => {
    const a = old.get(id);
    const b = now.get(id)!;
    return a && (a.milestone.id !== b.milestone.id || taskSignature(a.task) !== taskSignature(b.task));
  });
  const ms = (b: PlanBody | undefined): string => (b?.milestones ?? []).map((m) => `${m.id}\0${m.title}\0${m.goal ?? ''}\0${m.criteria.join('\0')}\0${m.dependsOn?.join(',') ?? '-'}\0${m.repos?.join(',') ?? '-'}`).join('\n');
  const milestones = ms(before) === ms(after) ? 0 : Math.max(1, Math.abs((after?.milestones.length ?? 0) - (before?.milestones.length ?? 0)));
  const notes = (b: PlanBody | undefined): Set<string> => new Set([...(b?.decisions ?? []).map((d) => JSON.stringify(d)), ...(b?.openQuestions ?? []).map((q) => `?${q}`)]);
  const was = notes(before);
  const is = notes(after);
  const decisions = [...is].filter((x) => !was.has(x)).length + [...was].filter((x) => !is.has(x)).length;
  return { added, changed, removed, milestones, decisions, repos: after?.repoChanges?.length ?? 0 };
}

/** What makes a task different, without what the board gave it. */
export function taskSignature(t: PlanTask): string {
  const { issueId: _i, ...rest } = t;
  return JSON.stringify(rest);
}

export const isEmptyDiff = (d: PlanDiff): boolean => !d.added.length && !d.changed.length && !d.removed.length && !d.milestones && !d.decisions && !d.repos;
