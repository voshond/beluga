import { z } from 'zod';
import type { AgentRef } from '../protocol.js';
import { commitAll, tryGit } from '../workspaces/git.js';
import type { Workspace } from '../workspaces/types.js';
import { MoveTransfers } from './move-transfer.js';
import { type PlanBranches } from './plans/move.js';
import { dropBranches, sendBranches, takeBranches } from './plans/move-git.js';
import { liveFrom } from './plans/progress.js';
import type { LogItem, Store } from './store.js';
import type { WorkspaceController } from './workspace-controller.js';

/**
 * Continue On (BLG-808): a worktree moves between your computers with its branch and its
 * conversation, each daemon's part. Your app runs it (src/machines/move.ts): check → pack here
 * (nothing committed unless you said so) → a new worktree there on that branch, its conversation
 * saved and handed to its agent with your next message, its .env asked about as for any new one →
 * the old one archived here, only once the new one is there.
 */

export interface WorktreeCheck {
  readonly name: string;
  readonly branch?: string;
  /** Files with changes not committed (the first few): asked about, never dropped. */
  readonly dirty: readonly string[];
  /** Its agent is at work now: it moves once that turn ends. */
  readonly busy: boolean;
  readonly project: { readonly name: string; readonly origin?: string };
}

export interface WorktreePackage {
  readonly version: 1;
  readonly ws: { readonly name: string; readonly branch: string; readonly agent?: AgentRef; readonly model?: string };
  readonly history: readonly LogItem[];
  readonly git: PlanBranches;
  readonly project: { readonly name: string; readonly origin?: string };
}

const Package = z
  .object({
    version: z.literal(1),
    ws: z.object({ name: z.string().min(1).max(200), branch: z.string().regex(/^[\w./-]+$/).max(250), agent: z.unknown().optional(), model: z.string().max(100).optional() }),
    history: z.array(z.object({ id: z.string(), channel: z.string(), type: z.string() }).passthrough()).max(50_000),
    git: z.union([z.object({ branches: z.array(z.string().regex(/^[\w./-]+$/)).max(1), via: z.literal('origin') }), z.object({ branches: z.array(z.string().regex(/^[\w./-]+$/)).max(1), via: z.literal('bundle'), bundle: z.string() })]),
    project: z.object({ name: z.string(), origin: z.string().optional() }),
  })
  .passthrough();

const WS = 'ws:';
const DIRTY_SHOWN = 8;

export interface WorktreeMoverDeps {
  readonly store: Store;
  readonly controller: WorkspaceController;
  readonly now?: () => number;
}

export class WorktreeMover {
  private readonly transfers: MoveTransfers;

  constructor(private readonly deps: WorktreeMoverDeps) {
    this.transfers = new MoveTransfers(deps.now);
  }

  private need(id: string): Workspace {
    const ws = this.deps.controller.manager.find(id);
    if (!ws || ws.archived) throw new Error('That worktree isn’t here any more');
    if (ws.kind !== 'worktree' || !ws.branch) throw new Error('Only a worktree (its own branch) continues on another computer');
    return ws;
  }

  async check(id: string): Promise<WorktreeCheck> {
    const ws = this.need(id);
    const status = (await tryGit(ws.path, ['status', '--porcelain'])) ?? '';
    const dirty = status.split('\n').filter(Boolean).map((l) => l.slice(3));
    return { name: ws.name, branch: ws.branch!, dirty: dirty.slice(0, DIRTY_SHOWN).concat(dirty.length > DIRTY_SHOWN ? [`${dirty.length - DIRTY_SHOWN} more`] : []), busy: this.busy(id), project: await this.project(ws) };
  }

  /** Packed to go: its branch sent where the other side can fetch it, its conversation. Changes not committed are committed only with `commit`. */
  async packOut(id: string, opts: { readonly commit?: boolean; readonly to: string }): Promise<{ readonly token: string; readonly chunks: number }> {
    const ws = this.need(id);
    if (this.busy(id)) throw new Error(`Its agent is at work: let it finish its turn, then continue it on ${opts.to}`);
    const c = await this.check(id);
    if (c.dirty.length && !opts.commit) throw new Error(`It has changes not committed (${c.dirty.join(', ')})`);
    if (c.dirty.length) await commitAll(ws.path, `Work in progress, before continuing on ${opts.to}`, { orAsBeluga: true });
    const root = this.deps.store.getState().projects.find((p) => p.workspaces.some((w) => w.id === id))?.root ?? ws.projectRoot;
    const git = await sendBranches(root, [ws.branch!]);
    if (!git) throw new Error(`Its branch ${ws.branch} isn’t here`);
    const pkg: WorktreePackage = {
      version: 1,
      ws: { name: ws.name, branch: ws.branch!, ...(ws.agent ? { agent: ws.agent } : {}), ...(ws.model ? { model: ws.model } : {}) },
      history: this.history(id),
      git,
      project: c.project,
    };
    return this.transfers.send(pkg, 'This worktree');
  }

  chunk = (token: string, n: number): string => this.transfers.chunk(token, n);
  receive = (token: string, n: number, total: number, data: string): void => this.transfers.receive(token, n, total, data);

  /**
   * A worktree here on its branch, in `projectId`: its conversation saved (its agent gets it with
   * your next message), its .env copied from this project's folder as for any new one. → its id.
   */
  async landIn(token: string, projectId: string, from: string): Promise<string> {
    const parsed = Package.safeParse(this.transfers.take(token));
    if (!parsed.success) throw new Error('What came over isn’t a worktree this Beluga can read (update Beluga on both computers)');
    const pkg = parsed.data as unknown as WorktreePackage;
    const m = this.deps.controller.manager;
    const project = this.deps.store.getState().projects.find((p) => p.id === projectId && p.root);
    if (!project) throw new Error('That project isn’t here');
    const made = await takeBranches(project.root, pkg.git);
    try {
      const ws = await m.createWorktreeOn(projectId, pkg.ws.name, pkg.ws.branch, { continuedFrom: from, carryFrom: `your agent on ${from}`, ...(pkg.ws.agent ? { agent: pkg.ws.agent } : {}), ...(pkg.ws.model ? { model: pkg.ws.model } : {}) });
      const channel = `${WS}${ws.id}`;
      const at = (this.deps.now ?? Date.now)();
      m.saveHistory(ws.id, [
        ...pkg.history.map((l) => ({ ...l, channel }) as LogItem),
        { id: `continued-${at}`, type: 'system', channel, text: `Continued here from ${from} on ${pkg.ws.branch}. Its agent here starts fresh: your next message takes this conversation along.`, ts: at, level: 'info' } as LogItem,
      ]);
      await this.deps.controller.refresh();
      return ws.id;
    } catch (err) {
      await dropBranches(project.root, made);
      throw err;
    }
  }

  /** The new one is there: this one is archived, saying where it went (its branch stays). */
  async done(id: string, to: string): Promise<void> {
    const ws = this.deps.controller.manager.find(id);
    if (!ws || ws.archived) return;
    this.deps.controller.manager.markContinuedOn(id, to);
    await this.deps.controller.archive(id, false, { quiet: true });
  }

  /** A worktree landed here whose move didn't finish: archived again (its branch stays). */
  async undo(id: string): Promise<void> {
    const ws = this.deps.controller.manager.find(id);
    if (!ws?.continuedFrom) throw new Error('That worktree didn’t come from another computer');
    if (!ws.archived) await this.deps.controller.archive(id, true, { quiet: true });
  }

  private busy(id: string): boolean {
    const live = liveFrom(this.deps.store.getState());
    return live.busy(`${WS}${id}`) || live.asking(`${WS}${id}`);
  }

  private history(id: string): LogItem[] {
    const channel = `${WS}${id}`;
    const saved = this.deps.controller.manager.loadHistory<LogItem>(id);
    const known = new Set(saved.map((l) => l.id));
    return [...saved, ...this.deps.store.getState().log.filter((l) => l.channel === channel && !known.has(l.id))];
  }

  private async project(ws: Workspace): Promise<{ readonly name: string; readonly origin?: string }> {
    const p = this.deps.store.getState().projects.find((x) => x.workspaces.some((w) => w.id === ws.id));
    const root = p?.root ?? ws.projectRoot;
    const origin = (await tryGit(root, ['remote', 'get-url', 'origin']))?.trim();
    return { name: p?.name ?? 'project', ...(origin ? { origin } : {}) };
  }
}

const movers = new WeakMap<WorkspaceController, WorktreeMover>();
/** The daemon's worktree mover (one per controller: it keeps packages between pieces). */
export function worktreeMover(store: Store, controller: WorkspaceController): WorktreeMover {
  let m = movers.get(controller);
  if (!m) movers.set(controller, (m = new WorktreeMover({ store, controller })));
  return m;
}
