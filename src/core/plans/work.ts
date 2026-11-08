import type { PlanAskInput, PlanTools } from '../../agent/types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRef } from '../../protocol.js';
import { agentName } from '../../shared/agent-label.js';
import type { Actor, Issue } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { CombineResult } from '../../workspaces/git.js';
import type { Intent } from '../intents.js';
import type { LogItem, Store } from '../store.js';
import type { WorkspaceController } from '../workspace-controller.js';
import { ApplyError, applyDraft, planBoard } from './apply.js';
import { dropEpics, syncEpics } from './epics.js';
import type { BodyInput, PlanOp, RepoChangeInput, TaskInput } from './edit.js';
import { type Autonomy, MAX_PLAN_REPOS, type Plan, type TestsAt, allTasks, checkerOf, isMultiRepo, milestoneRepos, planForHome, planRepos, planTaskOfIssue, planTitle, proposedRepos, runOf } from './model.js';
import { type PilotDeps, PlanPilot } from './pilot.js';
import type { TaskView } from './progress.js';
import { type PlanGit, planGitOf } from './plan-git.js';
import { type Plans, UNTITLED } from './plans.js';
import { type MilestoneWhere, type NearRepo, type PlanRepoInfo, checkFailedPrompt, checkerBrief, describePlan, handbackPrompt, headBrief, milestoneNote, milestoneWhere, planningBrief, sizeWords, workerNote } from './prompt.js';

/**
 * Plans at work: making a plan (its own conversation, in the project's main folder where Claude
 * only reads), approving it onto the board, running it (the pilot), and what Claude gets: the
 * plan's tools in its home conversation, and the plan a task belongs to in that task's worktree.
 */

export interface PlansWorkDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly board: BoardWork;
  readonly controller?: WorkspaceController;
  /** Ask your Claude in a conversation; returns the request's id, when it can (to follow a steered message). */
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** Steer a waiting message in now: the agent host's Steer Now (AgentHost.promote). */
  readonly promote?: (requestId: string) => boolean;
  /** Stop your Claude in one conversation (its queued messages too): the agent host's Stop. */
  readonly stopRun?: (channel: string) => void;
  readonly intend: (intent: Intent) => void;
  /** Combining a task's start from several branches (default: the project's folder, through the controller). */
  readonly combine?: (projectId: string, key: string, branches: readonly string[], into?: string) => Promise<CombineResult>;
  /** The plan's branch and pull request (default: the project's folder, through the controller; null: none). */
  readonly git?: PlanGit | null;
  /** The agent runner's run state, and taking over a stalled conversation (see watchdog.ts). */
  readonly alive?: (channel: string) => boolean;
  readonly takeOver?: (channel: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  /** A short name for a new plan from its goal (a quick model call; undefined when there's none). */
  readonly titlePlan?: (goal: string) => Promise<string | undefined>;
  readonly delayMs?: number;
  /** One Claude per milestone (default), or a worktree per task: see PlanPilot. */
  readonly workers?: 'milestone' | 'task';
  /** Stop a request of Beluga's that's no longer needed (AgentHost.cancelRun). */
  readonly cancel?: (requestId: string) => void;
  /** Tasks only you can do came up: see PilotDeps.forYou. */
  readonly forYou?: PilotDeps['forYou'];
  /** How long a plan may sit quiet before Beluga moves it along: see PilotDeps.rescueMs. */
  readonly rescueMs?: number;
}

const WS = 'ws:';

type PackageScripts = { readonly scripts?: Readonly<Record<string, string>> };

/** A repo's test commands, from its package.json scripts (none there, or no package.json: none). */
/** A project tagged in a message: "@calendar-api" (not "@claude:mia", nor inside an email address). */
const TAG = /(?:^|[\s(,])@([A-Za-z0-9][\w.-]*)(?![\w:@])/g;

/** How many projects outside the plan's sidebar group the planner hears of, by name. */
const MAX_NEAR_OTHERS = 15;
const MAX_GUIDE = 1200;
const GUIDE_FILES = ['CLAUDE.md', 'AGENTS.md'];

/** The top of a repo's CLAUDE.md or AGENTS.md (whole lines, capped): where people say how their repos fit together. */
const guideOf = (root: string): NearRepo['guide'] => {
  for (const file of GUIDE_FILES) {
    try {
      const text = readFileSync(path.join(root, file), 'utf8').trim();
      if (!text) continue;
      const cut = text.length > MAX_GUIDE ? text.slice(0, text.lastIndexOf('\n', MAX_GUIDE) > 0 ? text.lastIndexOf('\n', MAX_GUIDE) : MAX_GUIDE) : text;
      return { file, text: cut };
    } catch {
      // Not there: the next one.
    }
  }
  return undefined;
};

const testsOf = (root: string): readonly string[] => {
  try {
    const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageScripts;
    return ['typecheck', 'lint', 'test'].filter((s) => scripts?.[s]).map((s) => (s === 'test' ? 'npm test' : `npm run ${s}`));
  } catch {
    return [];
  }
};

export class PlansWork {
  readonly plans: Plans;
  readonly pilot: PlanPilot;
  /** Work handed back this session (plan id and the words), so the same thing reaches the head once. */
  private readonly handedBack = new Set<string>();

  constructor(private readonly deps: PlansWorkDeps) {
    this.plans = deps.plans;
    const git = deps.git === null ? undefined : (deps.git ?? (deps.controller?.manager ? planGitOf(deps.controller) : undefined));
    this.pilot = new PlanPilot({
      store: deps.store,
      plans: deps.plans,
      work: deps.board,
      askClaude: deps.askClaude,
      system: (channel, text) => deps.store.dispatch({ type: 'system', channel, text, level: 'info' }),
      ...(deps.combine ? { combine: deps.combine } : deps.controller ? { combine: (projectId, key, branches, into) => deps.controller!.manager.combineBase(projectId, key, branches, into) } : {}),
      ...(git ? { git } : {}),
      ...(deps.controller ? { allowFixup: (channel, dir) => deps.controller!.allowFixup?.(channel, dir) } : {}),
      // Each milestone's check: a conversation of its own in the project (folded into the plan), archived once it passed.
      ...(deps.controller
        ? {
            // On the plan's agent (BLG-503), like its workers; none picked: the project's.
            // In the milestone's repo (BLG-15): its branches are there to diff; the plan's other repos are read beside it.
            checkerChat: async (plan, milestone) => {
              const ws = await deps.controller!.newChat(milestoneRepos(plan, milestone)[0]!, `Check: ${milestone.title}`.slice(0, 40), undefined, { quiet: true });
              if (ws && plan.agent) deps.controller!.manager.setAgent(ws.id, plan.agent);
              return ws?.id;
            },
            // Its merge conflicts (BLG-4): a conversation of its own, so the head Claude only routes.
            // In the repo that conflicts (BLG-15); it may edit only the hidden worktree it's given (allowFixup).
            fixerChat: async (plan, projectId) => {
              const ws = await deps.controller!.newChat(projectId, `Fix: ${planTitle(plan)}`.slice(0, 40), undefined, { quiet: true });
              if (ws && plan.agent) deps.controller!.manager.setAgent(ws.id, plan.agent);
              return ws?.id;
            },
            retireChat: (id) => void deps.controller!.archive(id, false, { quiet: true }).catch(() => undefined),
          }
        : {}),
      ...(deps.alive ? { alive: deps.alive } : {}),
      ...(deps.takeOver ? { takeOver: deps.takeOver } : {}),
      ...(deps.promote ? { promote: deps.promote } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.delayMs !== undefined ? { delayMs: deps.delayMs } : {}),
      ...(deps.workers ? { workers: deps.workers } : {}),
      ...(deps.cancel ? { cancel: deps.cancel } : {}),
      ...(deps.forYou ? { forYou: deps.forYou } : {}),
      ...(deps.rescueMs !== undefined ? { rescueMs: deps.rescueMs } : {}),
      structure: (plan) => this.structure(plan.id),
      testsOf,
    });
    // A task of a plan: its worktree's Claude knows the plan and what runs beside it.
    deps.board.setBriefExtra((issue) => this.workerBrief(issue));
    // A milestone's worktree: its one Claude gets the milestone (its tasks in order, where each stands).
    deps.board.setRunBrief((channel) => this.milestoneBrief(channel));
    // A milestone across repos: its agent edits its worktrees in the other repos too (BLG-14).
    deps.board.setAlsoExtra((id) => this.alongPaths(id));
    // A plan across repos: its home reads the other repos' main folders too (read-only: it's a main-folder chat),
    // and a milestone reads the repos of earlier milestones it builds on.
    this.offReads = deps.controller?.setReadAlso?.((id) => [...new Set([...this.homeReads(id), ...this.upstreamReads(id), ...this.helperReads(id)])]);
  }

  private readonly offReads: (() => void) | undefined;

  stop(): void {
    this.offReads?.();
    this.pilot.stop();
    this.plans.flush();
  }

  private me = (): Actor => this.deps.board.me();
  private claude = (): Actor => this.deps.board.myClaude();

  // ------------------------------------------------------------------ for you (the API)

  /**
   * A new plan with Claude: a conversation of its own in the project's main folder (Claude reads
   * the code there and changes nothing), and the plan's page. Claude starts planning from `goal`.
   */
  /** `quiet`: started from elsewhere (Your Mac), so the Mac's window stays where it is. */
  async create(input: { readonly projectId: string; readonly projectIds?: readonly string[]; readonly goal: string; readonly autonomy?: Autonomy; readonly testsAt?: TestsAt; readonly agent?: AgentRef }, opts: { readonly quiet?: boolean } = {}): Promise<Plan> {
    const controller = this.deps.controller;
    if (!controller) throw new Error('Plans need a project folder');
    const goal = input.goal.trim();
    if (!goal) throw new Error('Say what the plan is for');
    const repos = this.localRepos(input.projectId, input.projectIds);
    const chat = await controller.newChat(input.projectId, UNTITLED, undefined, { quiet: true });
    if (!chat) throw new Error('Couldn’t start the plan’s conversation');
    const home = `${WS}${chat.id}`;
    const plan = this.plans.create({ projectId: input.projectId, ...(repos.length > 1 ? { repos } : {}), home, goal, ...(input.autonomy ? { autonomy: input.autonomy } : {}), ...(input.testsAt ? { testsAt: input.testsAt } : {}), ...(input.agent ? { agent: input.agent } : {}) }, this.me());
    if (!opts.quiet) this.deps.intend({ type: 'navigate', view: { kind: 'plan', id: plan.id } });
    this.deps.askClaude(goal, home, true);
    // Named in a moment by a quick model (your message is never its name); Claude's plan_write names it after that.
    void this.deps
      .titlePlan?.(goal)
      .then((title) => {
        const named = title ? this.plans.autoTitle(plan.id, title) : undefined;
        if (named) this.nameHome(named, UNTITLED);
      })
      .catch(() => undefined);
    return plan;
  }

  private repoInfo(id: string): PlanRepoInfo {
    const p = this.deps.store.getState().projects.find((x) => x.id === id);
    return { id, name: p?.name ?? id, root: p?.root ?? '' };
  }

  /** A plan's repos as the planner sees them: name and main folder (primary first), with what its draft adds and drops. */
  private repoInfos(plan: Plan): readonly PlanRepoInfo[] {
    return [...new Set([...proposedRepos(plan), ...planRepos(plan)])].map((id) => this.repoInfo(id));
  }

  /**
   * The projects on this Mac near a plan that it doesn't cover (BLG-28): those sharing a sidebar group
   * with one of its repos first (with the top of their CLAUDE.md or AGENTS.md), then the rest by name.
   */
  private nearRepos(plan: Plan): readonly NearRepo[] {
    const state = this.deps.store.getState();
    const covered = new Set(this.repoInfos(plan).map((r) => r.id));
    const roots = new Set(this.repoInfos(plan).map((r) => r.root).filter(Boolean));
    const local = state.projects.filter((p) => p.root && !covered.has(p.id) && !state.hiddenProjects.includes(p.root) && !state.hiddenProjects.includes(p.id));
    const groupOf = new Map<string, string>();
    for (const g of state.projectGroups ?? []) {
      if (!g.projects.some((root) => roots.has(root))) continue;
      for (const root of g.projects) if (!groupOf.has(root)) groupOf.set(root, g.name);
    }
    const grouped = local.filter((p) => groupOf.has(p.root)).slice(0, MAX_PLAN_REPOS);
    const others = local.filter((p) => !groupOf.has(p.root)).slice(0, MAX_NEAR_OTHERS);
    return [
      ...grouped.map((p) => {
        const guide = guideOf(p.root);
        return { id: p.id, name: p.name, root: p.root, group: groupOf.get(p.root)!, ...(guide ? { guide } : {}) };
      }),
      ...others.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    ];
  }

  /**
   * The main folders a plan's home reads beside its own (never edits: it's a main-folder chat): its
   * other repos, what its draft adds, and while it isn't done, the projects in their sidebar group.
   */
  homeReads(workspaceId: string): readonly string[] {
    const plan = planForHome(this.plans.state(), `${WS}${workspaceId}`);
    if (!plan || plan.status === 'done') return [];
    const own = this.repoInfo(plan.projectId).root;
    const near = this.nearRepos(plan).filter((r) => r.group);
    return [...new Set([...this.repoInfos(plan), ...near].map((r) => r.root).filter((root) => root && root !== own))];
  }

  /** Repos as Claude names them (a project's name or id) → project ids: the plan's first, then this Mac's; one it can't place is left as said, for the check to refuse. */
  private repoIds(planId: string, repos: readonly string[] | null | undefined): readonly string[] | null | undefined {
    if (!repos) return repos;
    const plan = this.plans.need(planId);
    const local = this.deps.store.getState().projects.filter((p) => p.root).map((p) => ({ id: p.id, name: p.name }));
    const infos = [...this.repoInfos(plan), ...local];
    return repos.map((r) => {
      const said = r.trim().toLowerCase();
      return infos.find((x) => x.id.toLowerCase() === said)?.id ?? infos.find((x) => x.name.toLowerCase() === said)?.id ?? r.trim();
    });
  }

  /** A repo change as Claude or you name it → a project on this Mac (by id), or a clear refusal. */
  private repoChange<T extends RepoChangeInput>(planId: string, change: T, by: 'claude' | 'user'): T {
    const [id] = this.repoIds(planId, [change.repo]) ?? [];
    const known = this.deps.store.getState().projects.some((p) => p.id === id && p.root);
    if (!known) {
      const near = this.nearRepos(this.plans.need(planId)).map((r) => r.name);
      throw new Error(`“${change.repo}” isn’t a project on this Mac${near.length ? ` (near this plan: ${near.join(', ')})` : ''}`);
    }
    return { ...change, repo: id!, by };
  }

  private withRepoIds<T extends { readonly repos?: readonly string[] | null }>(planId: string, m: T): T {
    if (!m.repos) return m;
    return { ...m, repos: this.repoIds(planId, m.repos) };
  }

  /** The repos a new plan covers (primary first): each one a project on this Mac, with its folder. */
  private localRepos(primary: string, more: readonly string[] | undefined): readonly string[] {
    const repos = planRepos({ projectId: primary, repos: more ?? [] });
    if (repos.length === 1) return repos;
    if (repos.length > MAX_PLAN_REPOS) throw new Error(`A plan covers at most ${MAX_PLAN_REPOS} projects`);
    const projects = this.deps.store.getState().projects;
    const missing = repos.filter((id) => !projects.some((p) => p.id === id && p.root));
    if (missing.length) throw new Error(`A plan can only cover projects on this Mac: ${missing.map((id) => `"${id}"`).join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} one of them`);
    return repos;
  }

  /** A plan's own conversation goes by the plan's name (in the sidebar too), unless you renamed it. */
  private nameHome(plan: Plan, was: string): void {
    const title = planTitle(plan);
    if (title === was || !plan.home.startsWith(WS)) return;
    const ws = this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === plan.home.slice(WS.length));
    if (ws?.kind === 'chat' && (ws.name === UNTITLED || ws.name === was.slice(0, 40))) void this.deps.controller?.renameChat(ws.id, title);
  }

  /** A plan's own conversation, made quietly (the demo's plan), with what was said there saved (as after a restart: it loads when it's opened). */
  async homeFor(projectId: string, title: string, said?: (channel: string) => readonly LogItem[]): Promise<string | undefined> {
    return this.savedChat(projectId, `Plan: ${title}`, said);
  }

  /** A milestone's checker conversation with what it said (the demo's passed milestone): its workspace id. */
  async checkerFor(projectId: string, title: string, said: (channel: string) => readonly LogItem[]): Promise<string | undefined> {
    return (await this.savedChat(projectId, `Check: ${title}`.slice(0, 40), said))?.slice(WS.length);
  }

  private async savedChat(projectId: string, name: string, said?: (channel: string) => readonly LogItem[]): Promise<string | undefined> {
    const chat = await this.deps.controller?.newChat(projectId, name, undefined, { quiet: true });
    if (!chat) return undefined;
    if (said) this.deps.controller?.manager.saveHistory(chat.id, said(`${WS}${chat.id}`));
    return `${WS}${chat.id}`;
  }

  /** Plan in the conversation you're in (the composer's Plan with Tasks): an empty draft, written from what you say next. */
  here(channel: string, autonomy?: Autonomy): Plan {
    const existing = planForHome(this.plans.state(), channel);
    if (existing && existing.status !== 'done') return existing;
    const ws = channel.startsWith(WS) ? this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === channel.slice(WS.length)) : undefined;
    const project = ws ? this.deps.store.getState().projects.find((p) => p.id === ws.projectId && p.root) : undefined;
    if (!ws || !project) throw new Error('Plans belong to a project: start one from a conversation in a project');
    return this.plans.create({ projectId: project.id, home: channel, ...(autonomy ? { autonomy } : {}) }, this.me());
  }

  /**
   * Approve the draft: its tasks go on the board, and the plan runs (or carries on with the changes).
   * Not while it has open questions (BLG-8): settle them first, or approve `anyway` (they stay on the plan, unsettled).
   */
  approve(id: string, by: Actor = this.me(), opts: { readonly anyway?: boolean } = {}): Plan {
    const plan = this.plans.need(id);
    const open = plan.draft?.openQuestions ?? [];
    if (open.length && !opts.anyway) throw new Error(`${open.length === 1 ? 'A question is' : `${open.length} questions are`} still open: ${open.map((q) => `“${q}”`).join(', ')}. Answer ${open.length === 1 ? 'it' : 'them'} in the plan’s conversation, or approve anyway.`);
    let applied: ReturnType<typeof applyDraft>;
    try {
      // The repos the draft adds or drops are the plan's first (BLG-30): its board, branches and PRs follow them.
      const covering = this.adoptRepos(plan, by);
      applied = applyDraft(this.plans.setBoard(id, planBoard(covering, this.deps.board.board)), this.deps.board.board, { by, me: this.deps.board.me() });
    } catch (err) {
      // What was made stays linked to the draft, so approving again doesn't make it twice.
      if (err instanceof ApplyError) this.plans.linkDraft(id, err.linked);
      throw err;
    }
    const { body, summary } = applied;
    const done = this.structure(this.plans.approved(id, body, by, summary).id);
    this.deps.store.dispatch({ type: 'system', channel: plan.home, text: plan.body ? `Changes applied: ${summary}.` : `Plan approved: ${summary} are on the board now.`, level: 'info' });
    this.pilot.schedule();
    return done;
  }

  /** A draft's repo changes made the plan's own (each repo still a project on this Mac). */
  private adoptRepos(plan: Plan, by: Actor): Plan {
    const changes = plan.draft?.repoChanges;
    if (!changes?.length) return plan;
    const repos = this.localRepos(plan.projectId, proposedRepos(plan));
    const said = changes.map((c) => `${c.change === 'add' ? 'added' : 'dropped'} ${this.repoInfo(c.repo).name}`).join(', ');
    return this.plans.setRepos(plan.id, repos, by, said);
  }

  discard(id: string): Plan | undefined {
    return this.plans.discard(id, this.me());
  }

  /**
   * Your changes: an approved plan without waiting changes takes them at once (you're the one approving).
   * A repo you put in or take out is yours; turning down one Claude suggested is a decision it holds to.
   */
  edit(id: string, given: readonly PlanOp[]): Plan {
    const ops = given.flatMap((o) => (o.op === 'repo' ? this.yourRepoOp(id, o) : [o]));
    const plan = this.plans.need(id);
    const retitle = ops.length === 1 && ops[0]!.op === 'retitle' && ops[0]!.goal === undefined && ops[0]!.title !== undefined;
    if (retitle) {
      const named = this.plans.retitle(id, ops[0]!.op === 'retitle' ? ops[0]!.title! : '', this.me());
      this.nameHome(named, planTitle(plan));
      return this.structure(named.id);
    }
    const direct = Boolean(plan.body) && !plan.draft;
    const next = this.plans.editDraft(id, ops, this.me());
    return direct && next.draft ? this.approve(id) : next;
  }

  private yourRepoOp(id: string, op: Extract<PlanOp, { op: 'repo' }>): PlanOp[] {
    const mine = this.repoChange(id, op, 'user');
    const suggested = this.plans.need(id).draft?.repoChanges?.find((c) => c.repo === mine.repo && c.by === 'claude');
    const refused = suggested && (suggested.change === 'add') !== mine.on;
    if (!refused) return [mine];
    const name = this.repoInfo(mine.repo).name;
    this.deps.store.dispatch({ type: 'system', channel: this.plans.need(id).home, text: mine.on ? `You kept ${name} in the plan.` : `You left ${name} out of the plan.`, level: 'info' });
    return [mine, { op: 'decide', decision: { question: `Should this plan cover ${name}?`, answer: mine.on ? `Yes: keep ${name} in it` : `No: leave ${name} out`, by: 'user' } }];
  }

  setAutonomy(id: string, autonomy: Autonomy, milestone?: string): Plan {
    const plan = this.plans.setAutonomy(id, autonomy, this.me(), milestone);
    this.pilot.schedule();
    return plan;
  }

  setPaused(id: string, paused: boolean): Plan {
    const plan = this.plans.setPaused(id, paused, this.me());
    this.pilot.schedule();
    return plan;
  }

  setParallel(id: string, n: number): Plan {
    const plan = this.plans.setMaxParallel(id, n, this.me());
    this.pilot.schedule();
    return plan;
  }

  /** When the plan runs its test suites: each milestone's check, or only the final step. */
  setTestsAt(id: string, testsAt: TestsAt): Plan {
    return this.plans.setTestsAt(id, testsAt, this.me());
  }

  /**
   * Who works the plan's milestones and tasks (BLG-498): `agent`, or your default (null). Work that
   * starts from now on gets it; milestones and tasks already at work keep the agent they opened with
   * (switching mid-run would lose their sessions). A task's own agent still beats it. → in words.
   */
  setWorkAgent(id: string, agent: AgentRef | null): string {
    const plan = this.plans.setWorkAgent(id, agent ?? undefined, this.me());
    const who = agent ? agentName(agent, { model: true }) : 'your default agent';
    const busy = Object.values(plan.runs).filter((r) => r?.agent && !r.passedAt).length;
    return busy ? `${who} works what starts next; the ${busy === 1 ? 'milestone' : `${busy} milestones`} already at work keep${busy === 1 ? 's' : ''} ${busy === 1 ? 'its' : 'their'} agent` : `${who} works this plan’s milestones and tasks`;
  }

  pass(id: string, milestone: string): Plan {
    return this.pilot.pass(id, milestone, this.me());
  }

  /** “Tidy up N merged task worktrees?”: only Yes merges and clears them away (see PlanPilot.tidyUp). */
  tidyUp(id: string, yes: boolean): Plan {
    return this.pilot.tidyUp(id, yes, this.me());
  }

  /** Not yet: what's missing goes to the head Claude, which adds the work to the plan. */
  sendBack(id: string, milestone: string, note: string): Plan {
    const plan = this.plans.need(id);
    const m = plan.body?.milestones.find((x) => x.id === milestone);
    if (!m) throw new Error('That milestone isn’t in the approved plan');
    const text = note.trim();
    if (!text) throw new Error('Say what’s missing');
    this.plans.note(id, 'failed', `sent “${m.title}” back: ${text}`, this.me());
    this.deps.askClaude(`Milestone “${m.title}” isn't done yet: ${text}\n\nAdd the tasks that fix it to this milestone with plan_update (the user approves them), or tell me what you need.`, plan.home, true);
    return this.plans.need(id);
  }

  /** Ask the head Claude to check a milestone again. */
  recheck(id: string, milestone: string): Plan {
    this.pilot.recheck(id, milestone);
    return this.plans.need(id);
  }

  /** The plan's pull request (its branch → main), merging it on GitHub, or merging the branch here. */
  openPr(id: string): Promise<Plan> {
    return this.pilot.openPr(id);
  }

  mergePr(id: string, opts: { readonly auto?: boolean } = {}, repo?: string): Promise<Plan> {
    return this.pilot.mergePr(id, opts, repo);
  }

  mergeLocal(id: string, repo?: string): Promise<Plan> {
    return this.pilot.mergeLocal(id, repo);
  }

  /** A conflict Claude couldn't fix: asked again now. */
  retryConflicts(id: string): Plan {
    return this.pilot.retryConflicts(id);
  }

  /** Where its conflict waits to be fixed (undefined: none). */
  conflictDir(id: string): string | undefined {
    return this.pilot.conflictDir(id);
  }

  /** Its pull request conflicts with main: main merged into the plan's branch (a conflict goes to its Claude). */
  bringInMain(id: string, repo?: string): Promise<Plan> {
    return this.pilot.bringInMain(id, repo);
  }

  /** `agent` (Start with…, BLG-506): who works it this once; none: the task's own, the plan's, or your default. */
  startTask(id: string, task: string, agent?: AgentRef): Promise<string> {
    return this.pilot.startNow(id, task, this.me(), agent);
  }

  /** Wake a task whose Claude stopped without finishing (Resume on its card). */
  resumeTask(id: string, task: string): string {
    return this.pilot.resume(id, task);
  }

  remove(id: string): void {
    const plan = this.plans.get(id);
    if (plan?.epics) dropEpics(plan, this.deps.board.board, { kind: 'beluga' });
    this.plans.remove(id);
  }

  /**
   * The plan's shape on the board (an epic for it, one per milestone, its tasks under them): made or
   * brought up to date. Never in the way: a board that can't take it leaves the plan as it is.
   */
  private structure(id: string): Plan {
    const plan = this.plans.need(id);
    if (!plan.body || plan.status === 'draft') return plan;
    try {
      const epics = syncEpics(plan, this.deps.board.board, { kind: 'beluga' });
      return epics ? this.plans.setEpics(id, epics) : plan;
    } catch (err) {
      this.plans.note(id, 'problem', `couldn’t show the plan as epics on the board: ${err instanceof Error ? err.message : String(err)}`, { kind: 'beluga' });
      return this.plans.need(id);
    }
  }

  setStyle(text: string): void {
    this.plans.setStyle(text);
  }

  // ------------------------------------------------------------------ for Claude

<<<<<<< HEAD
  /** A run in a plan's home conversation (yours): the plan's tools, and how to plan or run it. `said`: what you asked in it (kept as the plan's request until it's approved). */
  forRun(channel: string, from: string, said?: string): { readonly tools?: PlanTools; readonly brief?: string } | undefined {
=======
  /** A run in a plan's home conversation (yours): the plan's tools, and how to plan or run it. */
  forRun(channel: string, from: string): { readonly tools?: PlanTools; readonly brief?: string; readonly checker?: boolean } | undefined {
>>>>>>> upstream/main
    const me = this.deps.board.me();
    if (me.kind !== 'person' || from !== me.id) return undefined;
    // A milestone's checker: its brief, and only plan_get and plan_gate.
    const checking = checkerOf(this.plans.state(), channel);
    if (checking) {
      if (checking.plan.status !== 'active' || !checking.plan.body) return undefined;
      const view = this.pilot.view(checking.plan);
      const m = view.milestones.find((x) => x.milestone.id === checking.milestone);
<<<<<<< HEAD
      return m ? { tools: this.checkerTools(checking.plan.id, m.milestone.id), brief: checkerBrief(view, m, this.pilot.repoChecks(checking.plan, m.milestone)) } : undefined;
=======
      return m ? { tools: this.checkerTools(checking.plan.id, m.milestone.id), brief: checkerBrief(view, m), checker: true } : undefined;
>>>>>>> upstream/main
    }
    const found = planForHome(this.plans.state(), channel);
    if (!found) return this.workerOf(channel);
    const plan = this.tagged((said && this.plans.noteRequest(found.id, said)) || found, said ?? '');
    const board = this.deps.store.getState().board;
    const view = this.pilot.view(plan);
    const planning = planningBrief(plan, board, this.plans.planningStyle, this.repoInfos(plan), this.nearRepos(plan));
    const brief = plan.body ? headBrief(view) + planning : planning;
    return { tools: this.toolsFor(plan.id), brief };
  }

  /**
   * Repos you tag in the plan's chat ("also touch @calendar-api", BLG-32): projects of this Mac it
   * doesn't cover yet go in its draft as your repo changes, so its Claude plans with them. Only
   * proposed, on an approved plan too: approving applies them.
   */
  private tagged(plan: Plan, said: string): Plan {
    if (plan.status === 'done' || !(plan.draft ?? plan.body)) return plan;
    const names = new Set([...said.matchAll(TAG)].map((m) => m[1]!.replace(/[.-]+$/, '').toLowerCase()));
    const covered = new Set(proposedRepos(plan));
    const add = this.deps.store
      .getState()
      .projects.filter((p) => p.root && names.has(p.name.toLowerCase()) && !covered.has(p.id))
      .map((p) => p.id);
    if (!add.length) return plan;
    try {
      return this.plans.editDraft(plan.id, add.map((repo) => ({ op: 'repo' as const, repo, on: true, why: 'you tagged it in the plan’s chat', by: 'user' as const })), this.me(), 'tagged in the chat');
    } catch (err) {
      this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `Couldn’t add ${add.map((id) => this.repoInfo(id).name).join(', ')} to the plan: ${err instanceof Error ? err.message : String(err)}`, level: 'info' });
      return plan;
    }
  }

  /** A worktree doing a running plan's tasks (its milestone's one Claude, or one task's): the plan and which tasks are its. */
  private worktreeOf(wsId: string): { readonly plan: Plan; readonly tasks: readonly TaskView[] } | undefined {
    for (const plan of this.plans.list()) {
      if (plan.status !== 'active' || !plan.body) continue;
      const tasks = this.pilot.view(plan).milestones.flatMap((m) => m.tasks).filter((t) => t.issue?.worktrees.includes(wsId) && !t.forYou);
      if (tasks.length) return { plan, tasks };
    }
    return undefined;
  }

  /** A run in a plan task's worktree: a worker's plan tools (plan_ask, plan_handback), no brief (its board brief says the plan). */
  private workerOf(channel: string): { readonly tools: PlanTools } | undefined {
    if (!channel.startsWith(WS)) return undefined;
    const wsId = channel.slice(WS.length);
    const hit = this.worktreeOf(wsId);
    return hit ? { tools: this.workerTools(hit.plan.id, wsId) } : undefined;
  }

  private workerTools(planId: string, wsId: string): PlanTools {
    const refuse = (): never => {
      throw new Error('You work on this milestone’s tasks: plan_ask and plan_handback are yours here');
    };
    return {
      worker: true,
      get: refuse,
      write: refuse,
      update: refuse,
      start: async () => refuse(),
      message: refuse,
      gate: refuse,
      ask: (input) => this.askUser(planId, wsId, input),
      handback: (what, why) => this.handback(planId, wsId, what, why),
    };
  }

  /** A worker's question (BLG-6): kept on the plan, asked in its conversation (PlanDecisions), answered back here. */
  private askUser(planId: string, wsId: string, input: PlanAskInput): string {
    const hit = this.worktreeOf(wsId);
    if (!hit || hit.plan.id !== planId) throw new Error('This worktree isn’t doing a task of a running plan any more');
    const t = this.workerTask(hit.tasks, input.task);
    const question = input.question.replace(/\s+/g, ' ').trim();
    const seen = new Set<string>();
    const options = input.options
      .map((o) => ({ label: o.label.replace(/\s+/g, ' ').trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) }))
      .filter((o) => o.label && !seen.has(o.label.toLowerCase()) && seen.add(o.label.toLowerCase()));
    if (!question) throw new Error('Say what you ask');
    if (options.length < 2) throw new Error('Give at least two different options (they can always write their own)');
    const recommended = options.find((o) => o.label.toLowerCase() === input.recommended?.trim().toLowerCase())?.label;
    const why = input.why?.replace(/\s+/g, ' ').trim();
    const run = runOf(input.run);
    const key = t.issue?.key ?? t.task.id;
    const replaced = Boolean(hit.plan.asks?.[t.task.id]);
    this.plans.setAsk(planId, t.task.id, { task: t.task.id, question, ...(why ? { why } : {}), options, ...(recommended ? { recommended } : {}), ...(input.multi ? { multi: true } : {}), ...(run ? { run } : {}), worktree: wsId, at: Date.now() });
    this.plans.note(planId, 'note', `${key} asks the user: ${question.slice(0, 200)}`, this.claude());
    return [
      `Asked the user about ${key}${replaced ? ' (in place of your earlier question on it)' : ''}: it’s in the plan’s conversation and on their phone.`,
      'Carry on with what doesn’t depend on the answer. When nothing else is left, end your turn: the answer comes to you here, and is recorded in the task’s Decisions.',
    ].join(' ');
  }

  /** The task a worker means: the one it names (its key or plan id), else the one it's on, else its next. */
  private workerTask(tasks: readonly TaskView[], named?: string): TaskView {
    const want = named?.trim().toLowerCase();
    if (want) {
      const t = tasks.find((x) => x.task.id.toLowerCase() === want || x.issue?.key.toLowerCase() === want);
      if (!t) throw new Error(`“${named}” isn’t one of this worktree’s tasks: ${tasks.map((x) => x.issue?.key ?? x.task.id).join(', ')}`);
      return t;
    }
    const on = tasks.find((t) => t.state === 'running' || t.state === 'asking' || t.state === 'idle' || t.state === 'stalled') ?? tasks.find((t) => t.state === 'ready');
    if (!on) throw new Error('None of this worktree’s tasks is under way: name the task it’s about');
    return on;
  }

  /** Work a worker found outside its tasks (BLG-7): to the plan's head, which proposes it as a plan change. Once per piece of work. */
  private handback(planId: string, wsId: string, what: string, why: string): string {
    const hit = this.worktreeOf(wsId);
    if (!hit || hit.plan.id !== planId) throw new Error('This worktree isn’t doing a task of a running plan any more');
    const said = what.replace(/\s+/g, ' ').trim();
    const seen = `${planId}:${said.toLowerCase()}`;
    if (this.handedBack.has(seen)) return 'You handed that back already: the plan’s head has it. Go on with your own tasks.';
    this.handedBack.add(seen);
    const on = hit.tasks.find((t) => t.state === 'running' || t.state === 'asking' || t.state === 'idle' || t.state === 'stalled') ?? hit.tasks[0]!;
    const view = this.pilot.view(hit.plan);
    const m = view.milestones.find((x) => x.milestone.id === on.milestoneId);
    const from = on.issue?.key ?? on.task.id;
    this.plans.note(planId, 'note', `${from} handed back: ${said.slice(0, 200)}`, this.claude());
    this.deps.askClaude(handbackPrompt(from, m?.milestone.title ?? 'its milestone', what, why, (m?.autonomy ?? hit.plan.autonomy) === 'autopilot'), hit.plan.home, false);
    return 'Handed back to the plan: its head proposes it as a plan change. Go on with your own tasks.';
  }

  /** In a task's worktree: the plan it's part of. */
  private workerBrief(issue: Issue): string {
    const hit = planTaskOfIssue(this.plans.state(), issue.id);
    if (!hit || hit.plan.status !== 'active') return '';
    return workerNote(this.pilot.view(hit.plan), hit.task.id);
  }

  /** In a milestone's worktree (its one Claude): the milestone, and the task it's on (for the task tools). */
  private milestoneBrief(channel: string): { readonly brief: string; readonly current?: Issue } | undefined {
    if (!channel.startsWith(WS)) return undefined;
    const wsId = channel.slice(WS.length);
    const found = this.milestoneIn(wsId);
    if (!found) return undefined;
    const view = this.pilot.view(found.plan);
    const m = view.milestones.find((x) => x.milestone.id === found.id);
    if (!m) return undefined;
    const mine = m.tasks.filter((t) => t.issue?.worktrees.includes(wsId));
    const current = mine.find((t) => t.state === 'running' || t.state === 'idle' || t.state === 'asking' || t.state === 'stalled') ?? mine.find((t) => t.state === 'ready');
    return { brief: milestoneNote(view, m, current, this.whereOf(found.plan, found.id)), ...(current?.issue ? { current: current.issue } : {}) };
  }

  /** The active plan milestone whose agent works in this worktree (its own, not one beside it). */
  private milestoneIn(workspaceId: string): { readonly plan: Plan; readonly id: string } | undefined {
    for (const plan of this.plans.list()) {
      if (plan.status !== 'active' || !plan.body) continue;
      const id = Object.keys(plan.runs).find((k) => plan.runs[k]?.agent?.worktree === workspaceId);
      if (id) return { plan, id };
    }
    return undefined;
  }

  private whereOf(plan: Plan, milestoneId: string): MilestoneWhere | undefined {
    const milestone = plan.body?.milestones.find((x) => x.id === milestoneId);
    return milestone ? milestoneWhere(plan, milestone, plan.runs[milestoneId]?.agent, this.deps.store.getState().projects) : undefined;
  }

  /** A milestone across repos: its worktrees in the other repos, which its agent edits too. */
  alongPaths(workspaceId: string): readonly string[] {
    const found = this.milestoneIn(workspaceId);
    return found ? (this.whereOf(found.plan, found.id)?.along.map((a) => a.path) ?? []) : [];
  }

  /**
   * A plan across repos: what its fixer and its checkers read beside their own main folder, never
   * edit: the plan's other repos, and a checker its milestone's worktrees (every repo it worked in).
   */
  helperReads(workspaceId: string): readonly string[] {
    const channel = `${WS}${workspaceId}`;
    const checking = checkerOf(this.plans.state(), channel);
    const plan = checking?.plan ?? this.plans.list().find((p) => p.fixer === workspaceId);
    if (!plan || plan.status === 'done' || !isMultiRepo(plan)) return [];
    const milestone = checking ? plan.body?.milestones.find((m) => m.id === checking.milestone) : undefined;
    const worktrees = milestone ? (this.pilot.repoChecks(plan, milestone) ?? []).flatMap((r) => r.worktrees) : [];
    const own = this.deps.store.getState().projects.find((p) => p.workspaces.some((w) => w.id === workspaceId))?.root;
    return [...worktrees, ...this.repoInfos(plan).map((r) => r.root).filter((root) => root && root !== own)];
  }

  /** A milestone building on earlier ones in other repos: their main folders, read-only. */
  upstreamReads(workspaceId: string): readonly string[] {
    const found = this.milestoneIn(workspaceId);
    return found ? [...new Set(this.whereOf(found.plan, found.id)?.upstream.map((u) => u.repo.root).filter(Boolean) ?? [])] : [];
  }

  /** A task Claude says is an existing board task (its key): that task, adopted into the plan. */
  private adopt<T extends Partial<TaskInput> & { readonly issue?: string }>(t: T, planId: string): T {
    if (!t.issue) return t;
    const { issue: key, ...rest } = t;
    const issue = this.deps.board.board.get(key);
    const plan = this.plans.need(planId);
    if (!issue) throw new Error(`There's no task ${key} on the board`);
    if (issue.projectId !== plan.projectId) throw new Error(`${issue.key} belongs to another project`);
    if (issue.plan && issue.plan.id !== planId) throw new Error(`${issue.key} is already part of another plan`);
    return { ...rest, issueId: issue.id } as T;
  }

  /**
   * A milestone's checker: it reads the plan and records its verdict on that milestone, nothing more.
   * The verdict reaches the head Claude as one line; a failed one with the notes, to add the fix tasks.
   */
  private checkerTools(planId: string, milestoneId: string): PlanTools {
    const full = this.toolsFor(planId);
    const refuse = (): never => {
      throw new Error('You check this milestone: only plan_get and plan_gate are yours here');
    };
    return {
      only: ['plan_get', 'plan_gate'],
      get: full.get,
      write: refuse,
      update: refuse,
      start: async () => refuse(),
      message: refuse,
      gate: (milestone, verdict, notes) => {
        const plan = this.plans.need(planId);
        const m = plan.body?.milestones.find((x) => x.id === milestoneId);
        if (!m) throw new Error('That milestone isn’t in the approved plan any more: nothing to record');
        if (milestone !== m.id && milestone.toLowerCase() !== m.title.toLowerCase()) throw new Error(`You check “${m.title}” only (id ${m.id})`);
        const said = full.gate(m.id, verdict, notes);
        if (!said.startsWith('Recorded')) return said;
        const first = notes.trim().split('\n')[0]!.slice(0, 200);
        const auto = (m.autonomy ?? plan.autonomy) === 'autopilot';
        if (verdict === 'pass') {
          this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `“${m.title}” checked: it passes${auto ? ', and the plan moves on' : '. It’s yours to pass'}. ${first}`, level: 'info' });
          return `${said} Your check is done: end your turn.`;
        }
        this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `“${m.title}” didn’t pass its check: ${first}`, level: 'info' });
        this.deps.askClaude(checkFailedPrompt(m.title, notes, auto), plan.home, false);
        return 'Recorded as failed. The plan’s Claude adds the fix tasks from your notes. Your check is done: end your turn.';
      },
    };
  }

  private toolsFor(planId: string): PlanTools {
    const plans = this.plans;
    const after = (change: () => Plan): string => {
      const was = planTitle(plans.need(planId));
      const plan = change();
      this.nameHome(plan, was);
      if (!plan.draft) return 'The plan is unchanged.';
      // On autopilot, the head Claude's changes to a running plan apply at once.
      if (plan.body && plan.autonomy === 'autopilot') {
        const applied = this.approve(plan.id, this.claude());
        return `Applied at once (the plan runs on autopilot): ${sizeWords(applied.body)}.`;
      }
      return plan.body ? `Proposed (${sizeWords(plan.draft)}): the user reviews the changes and applies them.` : `Saved the draft (${sizeWords(plan.draft)}). The user reviews it and clicks Approve; nothing is on the board until then.`;
    };
    return {
      get: () => describePlan(this.pilot.view(plans.need(planId))),
      write: (body: BodyInput) => after(() => plans.writeDraft(planId, { ...body, milestones: body.milestones.map((m) => ({ ...this.withRepoIds(planId, m), tasks: (m.tasks ?? []).map((t) => this.adopt(t, planId)) })), ...(body.repoEdits ? { repoEdits: body.repoEdits.map((c) => this.repoChange(planId, c, 'claude')) } : {}) }, this.claude())),
      update: (ops: readonly PlanOp[], reason?: string) =>
        after(() =>
          plans.editDraft(
            planId,
            ops.map((o) => (o.op === 'add_task' ? { ...o, task: this.adopt(o.task, planId) } : o.op === 'update_task' ? { ...o, patch: this.adopt(o.patch, planId) } : o.op === 'add_milestone' ? { ...o, milestone: { ...this.withRepoIds(planId, o.milestone), tasks: (o.milestone.tasks ?? []).map((t) => this.adopt(t, planId)) } } : o.op === 'update_milestone' ? this.withRepoIds(planId, o) : o.op === 'repo' ? this.repoChange(planId, o, 'claude') : o)),
            this.claude(),
            reason,
          ),
        ),
      gate: (milestone, verdict, notes) => {
        const plan = plans.need(planId);
        const m = plan.body?.milestones.find((x) => x.id === milestone || x.title.toLowerCase() === milestone.toLowerCase());
        if (!m) throw new Error(`There's no milestone "${milestone}" in the approved plan (milestones: ${(plan.body?.milestones ?? []).map((x) => x.id).join(', ')})`);
        // The user passed it while you checked: your verdict isn't needed any more.
        if (plan.runs[m.id]?.passedAt || (plan.merging?.[m.id] && !plan.merging[m.id]!.catchUp)) return 'The user already passed this milestone: nothing to record. Stop checking it and end your turn.';
        plans.recordCheck(planId, m.id, { by: this.claude(), verdict, notes });
        this.pilot.schedule();
        const auto = (m.autonomy ?? plan.autonomy) === 'autopilot';
        return verdict === 'pass' ? (auto ? 'Recorded: the milestone passes and the plan moves on.' : 'Recorded: the user passes the milestone.') : 'Recorded as failed. Add the fix tasks with plan_update.';
      },
      start: (task) => this.pilot.startNow(planId, task, this.claude()),
      message: (task, text, mode = 'queue') => {
        const plan = plans.need(planId);
        const hit = allTasks(plan.body).find((t) => t.task.id === task || (t.task.issueId && this.deps.board.board.get(t.task.issueId)?.key === task.toUpperCase()));
        if (!hit?.task.issueId) throw new Error(`There's no task "${task}" on the board from this plan`);
        const issue = this.deps.board.board.need(hit.task.issueId);
        const w = issue.worktrees.at(-1);
        if (!w || issue.worktreeGone) throw new Error(`${issue.key} hasn't started: nothing to tell yet (start it, or change its brief)`);
        const steer = mode === 'steer';
        // Shown there as the plan's message, not as yours.
        this.deps.store.dispatch({ type: 'system', channel: `${WS}${w}`, text: `${steer ? 'Urgent, from' : 'From'} the plan’s agent: ${text.trim().slice(0, 2000)}`, level: 'info' });
        const prompt = `${steer ? 'An urgent message' : 'A message'} from the head of the plan “${plan.body?.title ?? ''}” (another agent coordinating the plan, not the user):\n\n${text.trim()}`;
        const id = this.deps.askClaude(prompt, `${WS}${w}`, false);
        if (!steer) return `Queued for the agent working on ${issue.key}: it reads it when its current turn ends (its card shows it waiting; use mode "steer" if it can't wait)`;
        // Steered: in now (interrupting a long command or a dead run), and followed until it's read.
        if (id) this.pilot.steer(planId, hit.task.id, id, prompt);
        return `Steered into ${issue.key}: its agent gets it now (a long command or a stuck turn is interrupted). If it isn't read within 2 minutes, Beluga delivers it again`;
      },
      stop: (task) => {
        const plan = plans.need(planId);
        const hit = allTasks(plan.body).find((t) => t.task.id === task || (t.task.issueId && this.deps.board.board.get(t.task.issueId)?.key === task.toUpperCase()));
        const issue = hit?.task.issueId ? this.deps.board.board.get(hit.task.issueId) : undefined;
        const w = issue?.worktrees.at(-1);
        if (!issue || !w || issue.worktreeGone) throw new Error(`There's no started task "${task}" in this plan`);
        if (!this.deps.stopRun) throw new Error('Stopping isn’t available here');
        this.deps.stopRun(`${WS}${w}`);
        this.deps.store.dispatch({ type: 'system', channel: `${WS}${w}`, text: 'Stopped by the plan’s agent.', level: 'info' });
        return `Stopped the agent working on ${issue.key}. It waits: tell it what to do with plan_message_task, or start it again from the plan`;
      },
      pause: (paused) => {
        this.setPaused(planId, paused);
        return paused ? 'Paused: nothing new starts until the user (or you, when they ask) resumes it' : 'Resumed: ready tasks start again';
      },
    };
  }
}
