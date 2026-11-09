import { z } from 'zod';
import { carryProofFiles, prepareMoved } from '../board/moved.js';
import { MoveTransfers } from '../move-transfer.js';
import type { Actor, Issue } from '../board/model.js';
import type { Board } from '../board/board.js';
import type { LogItem, Store } from '../store.js';
import type { WorkspaceController } from '../workspace-controller.js';
import { commitAll, tryGit } from '../../workspaces/git.js';
import type { Plan, PlanMove } from './model.js';
import { type MoveCheck, type PlanPackage, landHistory, landPlan, moveBlocked, moveRunning, planBranches, planIssueIds } from './move.js';
import { dropBranches, sendBranches, takeBranches } from './move-git.js';
import type { Plans } from './plans.js';
import type { PlanView } from './progress.js';

/**
 * A plan moving between your computers (BLG-806), each daemon's part. Your app runs the move
 * (src/machines/move-plan.ts): check → pack here → land there → done here. Landing either takes
 * everything in or leaves nothing behind there; this side changes only once the copy is in.
 */

export interface PlanMoverDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly board: Board;
  readonly controller?: WorkspaceController;
  readonly view: (plan: Plan) => PlanView;
  readonly busy: (channel: string) => boolean;
  /** The plan's epics brought up to date, and the pilot told. */
  readonly settle: (planId: string) => void;
  readonly me: () => Actor;
  readonly now?: () => number;
}

const WS = 'ws:';

/** What a landing package must look like (it's from your own computer, but it's checked like any input). */
const Package = z
  .object({
    version: z.literal(1),
    plan: z.object({ id: z.string().min(1).max(60), projectId: z.string(), home: z.string(), status: z.enum(['draft', 'active', 'done']), runs: z.record(z.string(), z.unknown()), activity: z.array(z.unknown()) }).passthrough(),
    home: z.object({ name: z.string().max(200), items: z.array(z.object({ id: z.string(), channel: z.string(), type: z.string() }).passthrough()).max(50_000) }),
    issues: z.array(z.object({ id: z.string(), key: z.string(), number: z.number(), status: z.string(), blockedBy: z.array(z.string()), related: z.array(z.string()), proof: z.array(z.unknown()), activity: z.array(z.unknown()) }).passthrough()).max(2000),
    files: z.record(z.string(), z.object({ name: z.string().max(255), data: z.string() })),
    project: z.object({ name: z.string(), origin: z.string().optional() }),
    git: z.union([z.object({ branches: z.array(z.string().regex(/^[\w./-]+$/)).max(200), via: z.literal('origin') }), z.object({ branches: z.array(z.string().regex(/^[\w./-]+$/)).max(200), via: z.literal('bundle'), bundle: z.string() })]).optional(),
  })
  .passthrough();

export class PlanMover {
  private readonly transfers: MoveTransfers;

  constructor(private readonly deps: PlanMoverDeps) {
    this.transfers = new MoveTransfers(deps.now);
  }

  /** Packed to go, kept for your app to fetch in pieces → its token and how many pieces. */
  async packOut(id: string, opts: { readonly commit?: boolean; readonly to: string }): Promise<{ readonly token: string; readonly chunks: number }> {
    return this.transfers.send(await this.pack(id, opts), 'This plan');
  }

  /** One piece of a package going out (the last one lets it go). */
  chunk = (token: string, n: number): string => this.transfers.chunk(token, n);

  /** One piece of a package coming in. */
  receive = (token: string, n: number, total: number, data: string): void => this.transfers.receive(token, n, total, data);

  /** Every piece is in: the package landed here (see land). */
  async landIn(token: string, projectId: string, from: PlanMove): Promise<Plan> {
    const pkg = Package.safeParse(this.transfers.take(token));
    if (!pkg.success) throw new Error('What came over isn’t a plan this Beluga can read (update Beluga on both computers)');
    return this.land(pkg.data as unknown as PlanPackage, projectId, from);
  }

  private now = (): number => (this.deps.now ?? Date.now)();

  /** Whether it can move now, what's at work in it, and which worktrees have changes not committed. */
  async check(id: string): Promise<MoveCheck> {
    const plan = this.deps.plans.need(id);
    const blocked = moveBlocked(plan);
    const running = moveRunning(this.deps.view(plan), this.deps.busy);
    const dirty: string[] = [];
    for (const { dir, name } of this.worktrees(plan)) if ((await tryGit(dir, ['status', '--porcelain']))?.trim()) dirty.push(name);
    return { ...(blocked ? { blocked } : {}), running, dirty, paused: plan.paused, project: await this.project(plan.projectId) };
  }

  /**
   * Packed to go (nothing here changes, but for `commit`: changes not committed in its worktrees,
   * committed as you said). Refused while anything runs in it, or with changes you weren't asked about.
   */
  async pack(id: string, opts: { readonly commit?: boolean; readonly to: string }): Promise<PlanPackage> {
    const plan = this.deps.plans.need(id);
    const c = await this.check(id);
    if (c.blocked) throw new Error(c.blocked);
    if (c.running.length) throw new Error(`${upFirst(c.running.join(', '))} ${c.running.length === 1 ? 'is' : 'are'} at work: pause the plan and let ${c.running.length === 1 ? 'it' : 'them'} finish first`);
    if (c.dirty.length && !opts.commit) throw new Error(`${c.dirty.join(', ')} ${c.dirty.length === 1 ? 'has' : 'have'} changes not committed`);
    for (const w of this.worktrees(plan)) await commitAll(w.dir, `Work in progress, before the plan moved to ${opts.to}`, { orAsBeluga: true }).catch(() => false);
    const issues = planIssueIds(plan).flatMap((i) => this.deps.board.get(i) ?? []);
    const root = this.root(plan.projectId);
    const branches = plan.body && root ? await sendBranches(root, planBranches(plan, issues)) : undefined;
    const ws = plan.home.startsWith(WS) ? this.deps.controller?.manager.find(plan.home.slice(WS.length)) : undefined;
    return {
      version: 1,
      plan,
      home: { name: ws?.name ?? 'Plan', items: this.history(plan.home) },
      issues,
      files: carryProofFiles(issues),
      project: c.project,
      ...(branches ? { git: branches } : {}),
    };
  }

  /**
   * Landed here in `projectId`, paused: its branches, its conversation, its tasks, then the plan.
   * Anything that fails takes back what was done here, so nothing is left half moved.
   */
  async land(pkg: PlanPackage, projectId: string, from: PlanMove): Promise<Plan> {
    const ctl = this.deps.controller;
    if (!ctl) throw new Error('Plans need a project folder');
    const there = this.deps.plans.get(pkg.plan.id);
    if (there && !there.movedTo) throw new Error('This plan is here already');
    const root = this.root(projectId);
    if (!root) throw new Error('That project isn’t here');
    const made = pkg.git ? await takeBranches(root, pkg.git) : [];
    let chat: string | undefined;
    let tasks: readonly Issue[] = [];
    try {
      const ws = await ctl.newChat(projectId, pkg.home.name.slice(0, 40), undefined, { quiet: true });
      if (!ws) throw new Error('Couldn’t make the plan’s conversation here');
      chat = ws.id;
      const at = this.now();
      ctl.manager.saveHistory(ws.id, landHistory(pkg.home.items, pkg.plan.home, `${WS}${ws.id}`, from.name, at));
      const by = this.deps.me();
      const moved = prepareMoved(this.deps.board.state(), pkg.issues, { projectId, ...this.deps.board.keysFor(projectId), from: from.name, by, at });
      this.deps.board.putMoved(moved.issues, pkg.files);
      tasks = moved.issues;
      const plan = this.deps.plans.adopt(landPlan(pkg.plan, { projectId, home: `${WS}${ws.id}`, ids: moved.ids, branches: pkg.git?.branches ?? [], from, by }));
      this.deps.settle(plan.id);
      return this.deps.plans.need(plan.id);
    } catch (err) {
      if (this.deps.plans.get(pkg.plan.id)?.movedFrom) this.deps.plans.remove(pkg.plan.id);
      this.deps.board.dropMoved(tasks.map((t) => t.id));
      if (chat) await ctl.archive(chat, false, { quiet: true }).catch(() => undefined);
      await dropBranches(root, made);
      throw err;
    }
  }

  /** The copy runs on `to`: this one is its record from now on, its tasks archived, its conversations and worktrees put away. */
  async done(id: string, to: PlanMove): Promise<Plan> {
    const plan = this.deps.plans.need(id);
    if (plan.movedTo) return plan;
    const by = this.deps.me();
    const after = this.deps.plans.movedAway(id, to, by);
    this.deps.board.movedAway(planIssueIds(plan), to.name, by);
    const ctl = this.deps.controller;
    if (ctl) {
      const put = [plan.home, ...Object.values(plan.runs).flatMap((r) => [r.agent ? `${WS}${r.agent.worktree}` : '', r.checker ? `${WS}${r.checker}` : ''])].filter((c) => c.startsWith(WS));
      for (const c of new Set(put)) await ctl.archive(c.slice(WS.length), false, { quiet: true }).catch(() => undefined);
    }
    return after;
  }

  /** A landed copy whose move didn't finish (the old one couldn't be put away): taken back off here. */
  async undo(id: string): Promise<void> {
    const plan = this.deps.plans.get(id);
    if (!plan?.movedFrom || plan.movedTo) throw new Error('That plan didn’t move here');
    this.deps.plans.remove(id);
    this.deps.board.dropMoved(planIssueIds(plan));
    if (plan.home.startsWith(WS)) await this.deps.controller?.archive(plan.home.slice(WS.length), false, { quiet: true }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ inside

  private root(projectId: string): string | undefined {
    return this.deps.store.getState().projects.find((p) => p.id === projectId)?.root || undefined;
  }

  private async project(projectId: string): Promise<{ readonly name: string; readonly origin?: string }> {
    const name = this.deps.store.getState().projects.find((p) => p.id === projectId)?.name ?? 'project';
    const root = this.root(projectId);
    const origin = root ? (await tryGit(root, ['remote', 'get-url', 'origin']))?.trim() : undefined;
    return { name, ...(origin ? { origin } : {}) };
  }

  /** The worktrees of its milestones not passed yet that are here: their folders and what they're called. */
  private worktrees(plan: Plan): Array<{ readonly dir: string; readonly name: string }> {
    const m = this.deps.controller?.manager;
    if (!m || !plan.body) return [];
    return plan.body.milestones.flatMap((ms) => {
      const run = plan.runs[ms.id];
      const ws = run?.agent && !run.passedAt ? m.find(run.agent.worktree) : undefined;
      return ws && !ws.archived ? [{ dir: ws.path, name: `“${ms.title}”` }] : [];
    });
  }

  /** What was said in a conversation: saved, and said since. */
  private history(channel: string): LogItem[] {
    if (!channel.startsWith(WS)) return [];
    const saved = this.deps.controller?.manager.loadHistory<LogItem>(channel.slice(WS.length)) ?? [];
    const known = new Set(saved.map((l) => l.id));
    return [...saved, ...this.deps.store.getState().log.filter((l) => l.channel === channel && !known.has(l.id))];
  }
}

const upFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
