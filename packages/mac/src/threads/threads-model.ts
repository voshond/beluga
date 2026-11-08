import type { AppState } from '../../../../src/core/store.js';
import { type ThreadNode, stopOrder } from '../../../../src/core/threads/model.js';
import { type AgentRef, defaultAgentOf } from '../../../../src/protocol.js';
import { type AgentMark, agentMark } from '../../../../src/shared/agent-marks.js';
import { span } from '../../../../src/shared/clock.js';
import { resetWords } from '../../../../src/shared/run-failure.js';
import { agentName } from '../../../../src/shared/agent-label.js';
import { THREAD_WORDS, type ThreadState, isThreadWorking } from '../../../../src/shared/threads.js';
import { type ThreadFamilyParent, type ThreadNesting, mixedHarnesses, threadNesting, threadParent, threadRank, threadStateOf } from '../../../../src/ui/thread-tree.js';
import { activityOf } from '../../../../src/ui/workspace-models.js';
import { laterUntil } from '../../../../src/core/triage/facts.js';
import type { Workspace } from '../../../../src/workspaces/types.js';
import { type SubAgent, agentTitle, cappedAgents, subAgentsSummary } from '../claude-code/subagents-model.js';

/**
 * Child threads in the Mac app: which chat holds which, and how each one is doing. A child is a
 * normal workspace chat with a thread record on it; the daemon keeps the record. Pure: no React.
 */

export { THREAD_WORDS, isThreadWorking } from '../../../../src/shared/threads.js';
export { type ThreadFamilyParent, type ThreadNesting, mixedHarnesses, parentIdOf, threadNesting, threadStateOf } from '../../../../src/ui/thread-tree.js';

const WS = 'ws:';
const NO_THREADS: readonly Workspace[] = [];

export type ThreadFamilySource = Pick<AppState, 'prefs' | 'self' | 'projects' | 'log' | 'approvals' | 'questions' | 'plans' | 'board' | 'assistant'>;

/** One line of the Threads panel: a child thread, or a native sub-agent (it has no Stop). */
export interface ThreadFamilyRow {
  readonly kind: 'thread' | 'agent';
  readonly id: string;
  readonly title: string;
  readonly state: ThreadState;
  readonly mark: AgentMark;
  /** Its harness's runtime: a native sub-agent has its parent's. */
  readonly runtime: AgentRef['runtime'];
  readonly agent: string;
  readonly model?: string;
  /** When its current turn began. */
  readonly since: number;
  readonly endedAt?: number;
  /** Waiting on your usage limit: when Beluga's auto-continue sends it on. */
  readonly resumesAt?: number;
}

/** A chat's one line for a thread it started. */
export interface ThreadStart {
  readonly id: string;
  readonly title: string;
  readonly ts: number;
  readonly mark: AgentMark;
  readonly agent: string;
  /** It has no page to open now. */
  readonly archived?: true;
}

export interface ThreadFamilyView {
  readonly parent?: ThreadFamilyParent;
  readonly rows: readonly ThreadFamilyRow[];
  readonly running: number;
  /** Every working thread under this chat, each after its own children: the order Stop all goes in. */
  readonly stoppable: readonly string[];
}

/** A child under its parent's row, as it is now. */
export interface ThreadChild {
  readonly ws: Workspace;
  readonly state: ThreadState;
}

/** One row in a chat's fold: a native sub-agent or a child thread, in the order they started. */
export type FoldRow = { readonly kind: 'agent'; readonly sub: SubAgent; readonly startedAt: number } | ({ readonly kind: 'thread'; readonly startedAt: number } & ThreadChild);

/** The panel of one chat: its parent, its children and sub-agents. Undefined: it has neither, or threads are off. */
export function threadFamilyView(state: ThreadFamilySource, ws: Workspace, agents: readonly SubAgent[]): ThreadFamilyView | undefined {
  if (!state.prefs.agentThreads) return undefined;
  const live = state.projects.flatMap((p) => p.workspaces).filter((w) => !w.archived);
  const channel = `${WS}${ws.id}`;
  const children = live.filter((w) => w.thread?.parent === channel);
  if (!ws.thread && !children.length && !agents.length) return undefined;
  const rows = orderRows([...children.map((w) => threadFamilyRow(state, w)), ...agents.map((sub) => agentFamilyRow(state, ws, sub))]);
  const nodes = live.flatMap((w): ThreadNode[] => (w.thread ? [{ id: w.id, channel: `${WS}${w.id}`, thread: w.thread }] : []));
  const byId = new Map(live.map((w) => [w.id, w]));
  const parent = ws.thread ? threadParent(state, ws, byId) : undefined;
  return {
    ...(parent ? { parent } : {}),
    rows,
    running: rows.filter((r) => isThreadWorking(r.state)).length,
    stoppable: stopOrder(nodes, channel).map((n) => n.id).filter((id) => isThreadWorking(threadStateOf(state, byId.get(id)!) ?? 'done')),
  };
}

/** A child chat's line at its top: the chat that started it. Undefined: it is no thread, or threads are off. */
export function startedBy(state: ThreadFamilySource, channel: string): ThreadFamilyParent | undefined {
  if (!state.prefs.agentThreads || !channel.startsWith(WS)) return undefined;
  const all = state.projects.flatMap((p) => p.workspaces);
  const ws = all.find((w) => w.id === channel.slice(WS.length));
  return ws?.thread ? threadParent(state, ws, new Map(all.filter((w) => !w.archived).map((w) => [w.id, w]))) : undefined;
}

/**
 * Who sent a message to a child, for its label: the parent's title. Only the thread tools send an
 * agent's line with a request behind it; a child's own agent speaking in the chat has none.
 */
export function threadSender(state: ThreadFamilySource, item: { readonly channel?: string; readonly byAgent: boolean; readonly request?: string }): string | undefined {
  if (!item.byAgent || !item.request || !item.channel) return undefined;
  return startedBy(state, item.channel)?.title;
}

/** The threads a chat started, for its one compact line each, in start order. */
export function threadStarts(state: Pick<ThreadFamilySource, 'prefs' | 'self' | 'projects'>, channel: string): ThreadStart[] {
  if (!state.prefs.agentThreads) return [];
  return state.projects
    .flatMap((p) => p.workspaces)
    .filter((w) => w.thread?.parent === channel)
    .map((w) => {
      const harness = w.agent ?? defaultAgentOf(state.self);
      return { id: w.id, title: w.name, ts: w.thread!.startedAt, mark: agentMark(harness), agent: agentName(harness), ...(w.archived ? { archived: true as const } : {}) };
    })
    .sort((a, b) => a.ts - b.ts);
}

/** Needs you, then working, then finished: each in creation order, so a settled row stays where it is among its batch. */
export function orderRows(rows: readonly ThreadFamilyRow[]): ThreadFamilyRow[] {
  return [...rows].sort((a, b) => threadRank(a.state) - threadRank(b.state) || a.since - b.since);
}

/** The rows in view: all that work, and the newest few that finished. Older finished rows fold into Earlier. */
export function panelRows(rows: readonly ThreadFamilyRow[], keepFinished: number, showAll: boolean): { shown: readonly ThreadFamilyRow[]; earlier: number } {
  if (showAll) return { shown: rows, earlier: 0 };
  const finished = rows.filter((r) => !isThreadWorking(r.state));
  const hide = new Set(finished.slice(0, Math.max(0, finished.length - keepFinished)));
  return { shown: rows.filter((r) => !hide.has(r)), earlier: hide.size };
}

/** The child threads under a chat's row now: none with threads off, and none put off till later (Remind Me Later) until it reminds you. */
export function threadsShownUnder(state: Parameters<typeof threadNesting>[0] & Parameters<typeof laterUntil>[0], id: string, now = Date.now()): readonly Workspace[] {
  const list = threadNesting(state).under.get(id) ?? NO_THREADS;
  const shown = list.filter((w) => laterUntil(state, `${WS}${w.id}`, now) === undefined);
  return shown.length === list.length ? list : shown;
}

/** The chats on the way down to the open one: each stays visible under a folded parent. */
export function openPath(nesting: ThreadNesting, open: string | undefined): ReadonlySet<string> {
  const path = new Set<string>();
  if (!open) return path;
  const parents = new Map<string, string>();
  for (const [parent, list] of nesting.under) for (const child of list) parents.set(child.id, parent);
  for (let at: string | undefined = open; at !== undefined && nesting.nested.has(at) && !path.has(at); at = parents.get(at)) path.add(at);
  return path;
}

/** Sub-agents and threads in one list, in start order: a row never moves when its work ends. */
export function foldRows(agents: readonly SubAgent[], threads: readonly ThreadChild[]): FoldRow[] {
  const rows: FoldRow[] = [...agents.map((sub): FoldRow => ({ kind: 'agent', sub, startedAt: sub.agent.startedAt })), ...threads.map((t): FoldRow => ({ kind: 'thread', ...t, startedAt: t.ws.thread!.startedAt }))];
  return threads.length ? rows.sort((a, b) => a.startedAt - b.startedAt) : rows;
}

/**
 * The rows a fold shows before "N earlier": working threads and the open row always, then the newest
 * few of the rest. Finished threads collapse first. With no thread it is cappedAgents, as before.
 */
export function capFold(rows: readonly FoldRow[], cap: number, isOn: (row: FoldRow) => boolean): { shown: FoldRow[]; hidden: number } {
  const working = rows.filter(holdsItsPlace);
  const { shown } = cappedAgents(rows.filter((r) => !holdsItsPlace(r)), Math.max(0, cap - working.length), isOn);
  const keep = new Set<FoldRow>([...working, ...shown]);
  return { shown: rows.filter((r) => keep.has(r)), hidden: rows.length - keep.size };
}

/** A fold in words: "2 threads · 1 sub-agent · 1 running". With no thread, the sub-agents' own words. */
export function foldSummary(rows: readonly FoldRow[]): string {
  const agents = rows.flatMap((r) => (r.kind === 'agent' ? [r.sub] : []));
  const threads = rows.filter((r) => r.kind === 'thread');
  if (!threads.length) return subAgentsSummary(agents);
  const running = foldRunning(rows);
  return [`${threads.length} thread${threads.length === 1 ? '' : 's'}`, agents.length ? `${agents.length} sub-agent${agents.length === 1 ? '' : 's'}` : '', running ? `${running} running` : ''].filter(Boolean).join(' · ');
}

/** A fold's row as the panel draws it: a thread, or a native sub-agent with its parent's harness. */
export function familyRowOf(state: ThreadFamilySource, parent: Workspace, row: FoldRow): ThreadFamilyRow {
  return row.kind === 'thread' ? threadFamilyRow(state, row.ws) : agentFamilyRow(state, parent, row.sub);
}

/** A row's last word: its timer while it works, else what it is now. */
export function rowEnd(row: ThreadFamilyRow, now: number): string {
  if (row.state === 'waiting_limit' && row.resumesAt !== undefined) return `Waiting · ${resetWords(row.resumesAt, now)}`;
  return row.state === 'running' ? span(now - row.since) : THREAD_WORDS[row.state];
}

export function foldRunning(rows: readonly FoldRow[]): number {
  return rows.filter((r) => (r.kind === 'agent' ? r.sub.agent.status === 'running' : isThreadWorking(r.state))).length;
}

/** What a fold holds, for its button's name. */
export function foldNoun(rows: readonly FoldRow[]): string {
  const threads = rows.some((r) => r.kind === 'thread');
  const agents = rows.some((r) => r.kind === 'agent');
  return threads && agents ? 'threads and sub-agents' : threads ? 'threads' : 'sub-agents';
}

/** The harness a row's mark shows, with threads on: the chat's own agent, else yours. A main folder has no mark. */
export function harnessOf(state: Pick<AppState, 'prefs' | 'self' | 'projects'>, ws: Pick<Workspace, 'agent' | 'kind'>): AgentRef | undefined {
  if (!state.prefs.agentThreads || ws.kind === 'main' || !mixedHarnesses(state)) return undefined;
  return ws.agent ?? defaultAgentOf(state.self);
}

/** A child thread's row. */
export function threadFamilyRow(state: ThreadFamilySource, w: Workspace): ThreadFamilyRow {
  const harness = w.agent ?? defaultAgentOf(state.self);
  const thread = w.thread!;
  const stateNow = threadStateOf(state, w) ?? 'queued';
  const model = w.model ?? harness.model;
  const endedAt = !isThreadWorking(stateNow) ? thread.outcome?.at : undefined;
  return {
    kind: 'thread',
    id: w.id,
    title: w.name,
    state: stateNow,
    mark: agentMark(harness),
    runtime: harness.runtime,
    agent: agentName(harness),
    ...(model ? { model } : {}),
    since: isThreadWorking(stateNow) ? (activityOf(state.log, `${WS}${w.id}`).startedAt ?? thread.startedAt) : thread.startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(stateNow === 'waiting_limit' && thread.limit ? { resumesAt: thread.limit.at } : {}),
  };
}

/** A native sub-agent's row: its parent chat's harness, and its own model when known. */
export function agentFamilyRow(state: Pick<ThreadFamilySource, 'self'>, ws: Pick<Workspace, 'agent'>, sub: SubAgent): ThreadFamilyRow {
  const harness = ws.agent ?? defaultAgentOf(state.self);
  const a = sub.agent;
  return {
    kind: 'agent',
    id: a.id,
    title: agentTitle(a),
    state: a.status === 'running' ? 'running' : a.status === 'failed' ? 'failed' : a.status === 'finished' || a.status === 'idle' ? 'done' : 'stopped',
    mark: agentMark(harness),
    runtime: harness.runtime,
    agent: agentName(harness),
    ...(a.model ? { model: a.model } : {}),
    since: a.startedAt,
    ...(a.status !== 'running' ? { endedAt: a.endedAt ?? a.lastAt } : {}),
  };
}

const holdsItsPlace = (row: FoldRow): boolean => row.kind === 'thread' && isThreadWorking(row.state);
