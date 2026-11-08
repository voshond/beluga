import { stopOrder } from '../core/threads/model.js';
import type { DomainState } from '../core/store.js';
import { defaultAgentOf } from '../protocol.js';
import { isThreadWorking } from '../shared/threads.js';
import { type ThreadNesting, mixedHarnesses, threadFamily, threadNodes, threadParent, threadRank, threadStateOf } from '../ui/thread-tree.js';
import type { Workspace } from '../workspaces/types.js';
import { agentRefView, clip, convTopic } from './needs-you.js';
import { plainLine } from './strip.js';
import type { BranchView, ConvSummary, ConvView, ThreadFamilyView, Topic } from './protocol.js';

/**
 * Child threads on the phone (1.47), read by the Mac's own rules (ui/thread-tree.ts). With threads
 * off a chat says nothing about them, as on the Mac, except what an archive or a delete would touch:
 * the records stay after the setting is turned off.
 */

const WS = 'ws:';

/** A row of Work: the mark it shows and the chat it sits under. */
export function threadRowOf(state: DomainState, channel: string, nesting: ThreadNesting): Pick<ConvSummary, 'harness' | 'parent'> {
  const ws = own(state, channel);
  if (!ws || !state.prefs.agentThreads) return {};
  const parent = nesting.nested.has(ws.id) ? convTopic(ws.thread!.parent) : undefined;
  return { ...(mixedHarnesses(state) ? { harness: agentRefView(ws.agent ?? defaultAgentOf(state.self)) } : {}), ...(parent ? { parent } : {}) };
}

/** A chat's family, for its Threads sheet. */
export function threadFamilyOf(state: DomainState, channel: string): Pick<ConvView, 'threadFamily'> {
  const ws = own(state, channel);
  if (!ws || !state.prefs.agentThreads) return {};
  const live = state.projects.flatMap((p) => p.workspaces).filter((w) => !w.archived);
  const found = live.filter((w) => w.thread?.parent === channel);
  const agents = nativeAgents(state, channel, ws);
  if (!ws.thread && !found.length && !agents.length) return {};
  const byId = new Map(live.map((w) => [w.id, w]));
  const stateOf = (w: Workspace) => threadStateOf(state, w) ?? 'queued';
  const children = found.sort((a, b) => threadRank(stateOf(a)) - threadRank(stateOf(b)) || a.thread!.startedAt - b.thread!.startedAt).slice(0, 100);
  const family: ThreadFamilyView = {
    ...(ws.thread ? { parent: parentOf(state, ws, byId) } : {}),
    children: children.flatMap((w) => {
      const topic = convTopic(`${WS}${w.id}`);
      return topic ? [{ id: clip(w.id, 200), topic, title: clip(w.name, 300), state: stateOf(w), working: isThreadWorking(stateOf(w)), harness: agentRefView(w.agent ?? defaultAgentOf(state.self)) }] : [];
    }),
    ...(agents.length ? { agents } : {}),
    chat: clip(ws.id, 200),
    marks: mixedHarnesses(state),
    stoppable: stopOrder(threadNodes(live), channel)
      .filter((n) => isThreadWorking(stateOf(byId.get(n.id)!)))
      .slice(0, 200)
      .map((n) => n.id),
  };
  return { threadFamily: family };
}

/** What archiving or deleting this chat would ask about. Same counts as the Mac's dialogs. */
export function familyOf(state: DomainState, id: string): Pick<BranchView, 'threads'> {
  const del = threadFamily(state, id, 'delete');
  return del.count ? { threads: { archive: threadFamily(state, id, 'archive'), delete: del } } : {};
}

/** The chat's native sub-agents (no background work), the newest 40, as its runs list them: read-only rows with the chat's harness. */
function nativeAgents(state: DomainState, channel: string, ws: Workspace): NonNullable<ThreadFamilyView['agents']> {
  const harness = agentRefView(ws.agent ?? defaultAgentOf(state.self));
  return state.log
    .flatMap((l) => (l.type === 'agent' && l.channel === channel ? l.subagents.filter((s) => s.kind !== 'background') : []))
    .slice(-40)
    .map((s) => ({ id: clip(s.id, 200), title: clip(plainLine(s.title, 300) || 'Sub-agent', 300), state: s.status, ...(s.startedAt !== undefined ? { startedAt: Math.round(s.startedAt) } : {}), harness }));
}

function parentOf(state: DomainState, ws: Workspace, byId: ReadonlyMap<string, Workspace>): NonNullable<ThreadFamilyView['parent']> {
  const p = threadParent(state, ws, byId);
  const topic: Topic | undefined = p.openId ? convTopic(`${WS}${p.openId}`) : undefined;
  return { title: clip(p.title, 300), gone: p.gone, ...(topic ? { topic } : {}), ...(p.state ? { state: p.state } : {}) };
}

function own(state: DomainState, channel: string): Workspace | undefined {
  if (!channel.startsWith(WS)) return undefined;
  const id = channel.slice(WS.length);
  return state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
}
