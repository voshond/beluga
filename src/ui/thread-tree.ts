import { isPlanOwned } from '../core/plans/owner.js';
import type { AppState } from '../core/store.js';
import { defaultAgentOf } from '../protocol.js';
import { type ThreadLive, type ThreadNode, deriveThreadState, subtree } from '../core/threads/model.js';
import { type ThreadState, isThreadWorking } from '../shared/threads.js';
import type { Workspace } from '../workspaces/types.js';
import { isRunning } from './format.js';
import { activityOf } from './workspace-models.js';

/**
 * Child threads as both screens read them: which chat holds which, how each is doing and what an
 * archive or a delete would touch. A child is a normal workspace chat with a thread record on it;
 * the daemon keeps the record. Pure: no React.
 */

const WS = 'ws:';

/** Which threads sit under a parent's row. Every other thread is a normal row at the top level. */
export interface ThreadNesting {
  readonly nested: ReadonlySet<string>;
  readonly under: ReadonlyMap<string, readonly Workspace[]>;
}

export interface ThreadFamilyParent {
  readonly title: string;
  readonly state?: ThreadState;
  /** The chat to open. Unset: the parent is gone, or it is not a workspace chat. */
  readonly openId?: string;
  readonly gone: boolean;
}

type LiveSource = Pick<AppState, 'log' | 'approvals' | 'questions'>;

const NO_NESTING: ThreadNesting = { nested: new Set(), under: new Map() };
/** The log is replaced on every streamed event, the projects are not: a row isn't drawn again for it. */
/** mixedHarnesses, once per projects list and self. */
const mixes = new WeakMap<object, { readonly self: unknown; readonly value: boolean }>();
const nestings = new WeakMap<object, { readonly plans: unknown; readonly board: unknown; readonly value: ThreadNesting }>();

/**
 * The threads each row holds. A thread nests only under a live parent in its own project that has
 * a row there: with any other parent (gone, archived, a Your Mac chat, a main folder, a plan's own)
 * it stays at the top level, so a kept child never drops out of the list.
 */
export function threadNesting(state: Pick<AppState, 'prefs' | 'projects' | 'plans' | 'board'>): ThreadNesting {
  if (!state.prefs.agentThreads) return NO_NESTING;
  const known = nestings.get(state.projects);
  if (known?.plans === state.plans && known.board === state.board) return known.value;
  const homes = new Set(state.plans.plans.map((p) => p.home));
  const all = state.projects.flatMap((p) => p.workspaces);
  const byId = new Map(all.map((w) => [w.id, w]));
  const nested = new Set<string>();
  const under = new Map<string, Workspace[]>();
  for (const child of all) {
    const id = parentIdOf(child);
    const parent = id === undefined ? undefined : byId.get(id);
    if (!parent || child.archived || parent.archived || parent.kind === 'main' || parent.projectId !== child.projectId) continue;
    if (homes.has(`${WS}${parent.id}`) || isPlanOwned(state, parent.id)) continue;
    nested.add(child.id);
    under.set(parent.id, [...(under.get(parent.id) ?? []), child]);
  }
  for (const list of under.values()) list.sort((a, b) => a.thread!.startedAt - b.thread!.startedAt);
  const value = { nested, under };
  nestings.set(state.projects, { plans: state.plans, board: state.board, value });
  return value;
}

/**
 * Whether harness marks show at all: only when the chats and worktrees listed now (not archived, not
 * a main folder) run two or more harnesses. One harness everywhere says nothing a mark would add.
 */
export function mixedHarnesses(state: Pick<AppState, 'prefs' | 'projects' | 'self'>): boolean {
  if (!state.prefs.agentThreads) return false;
  const known = mixes.get(state.projects);
  if (known && known.self === state.self) return known.value;
  const runtimes = new Set(state.projects.flatMap((p) => p.workspaces.flatMap((w) => (w.archived || w.kind === 'main' ? [] : [(w.agent ?? defaultAgentOf(state.self)).runtime]))));
  const value = runtimes.size >= 2;
  mixes.set(state.projects, { self: state.self, value });
  return value;
}

/** The workspace `id` of a thread's parent chat, when its parent is a workspace chat at all. */
export function parentIdOf(ws: Pick<Workspace, 'thread'>): string | undefined {
  const parent = ws.thread?.parentGone ? undefined : ws.thread?.parent;
  return parent?.startsWith(WS) ? parent.slice(WS.length) : undefined;
}

/**
 * A thread's state on this screen. The rules are the daemon's; a turn that is owed with no run yet
 * is on its way here, because the daemon writes "interrupted" itself after a restart.
 */
export function threadStateOf(state: LiveSource, ws: Workspace): ThreadState | undefined {
  if (!ws.thread) return undefined;
  const channel = `${WS}${ws.id}`;
  const activity = activityOf(state.log, channel);
  const live: ThreadLive | undefined = activity.running ? { run: 'running', ...(activity.awaiting || state.approvals.some((a) => a.channel === channel) || state.questions.some((q) => q.channel === channel) ? { needsYou: true } : {}) } : undefined;
  if (!live && ws.thread.owed.length) return 'queued';
  return deriveThreadState(ws.thread, live);
}

/** The chat that started a thread. `byId`: the chats that are live. */
export function threadParent(state: LiveSource & Pick<AppState, 'assistant'>, ws: Workspace, byId: ReadonlyMap<string, Workspace>): ThreadFamilyParent {
  const thread = ws.thread!;
  const id = parentIdOf(ws);
  const parent = id === undefined ? undefined : byId.get(id);
  // A Your Mac parent has no workspace: it is there while its chat is.
  if (!parent) return { title: thread.parentTitle, gone: !state.assistant.chats.some((c) => c.channel === thread.parent) };
  const stateNow = parent.thread ? threadStateOf(state, parent) : activityOf(state.log, `${WS}${parent.id}`).running ? 'running' : undefined;
  return { title: parent.name, openId: parent.id, gone: false, ...(stateNow ? { state: stateNow } : {}) };
}

export { threadRank } from '../shared/threads.js';

/**
 * The threads under the picked chats that a person's archive or delete would touch and that are not
 * picked themselves: all of them for a delete, those not archived yet for an archive. Their running
 * count is for the dialog's text.
 */
export function threadFamily(st: Pick<AppState, 'projects' | 'log' | 'selfId'>, picked: string | readonly string[], action: 'archive' | 'delete'): { readonly count: number; readonly running: number } {
  const ids = typeof picked === 'string' ? [picked] : picked;
  const all = st.projects.flatMap((p) => p.workspaces);
  const nodes = threadNodes(all);
  const under = new Map(ids.flatMap((id) => subtree(nodes, `${WS}${id}`)).map((n) => [n.id, n]));
  const asked = [...under.values()].filter((n) => !ids.includes(n.id) && (action === 'delete' || !all.find((w) => w.id === n.id)?.archived));
  const working = new Set(st.log.flatMap((l) => (l.type === 'agent' && l.owner === st.selfId && isRunning(l.status) ? [l.channel] : [])));
  return { count: asked.length, running: asked.filter((n) => working.has(n.channel)).length };
}

export const threadNodes = (all: readonly Workspace[]): ThreadNode[] => all.flatMap((w) => (w.thread ? [{ id: w.id, channel: `${WS}${w.id}`, thread: w.thread }] : []));
