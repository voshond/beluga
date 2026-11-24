import { reflectionOf } from '../core/memory/reflection.js';
import { MemoryError, MemoryStore } from '../core/memory/store.js';
import type { Session } from '../core/session.js';
import type { MemoryOverview, MemoryView } from '../shared/memory.js';
import type { Args, Method } from './api.js';

type MemoryMethod = Extract<Method, `memory.${string}`>;
type MemoryHandlers = { readonly [M in MemoryMethod]: (s: Session, ...args: Args<M>) => unknown };

const overview = (s: Session, store: MemoryStore): MemoryOverview => {
  const projects = s.store.getState().projects.filter((p) => p.root);
  const known = new Set(projects.map((p) => p.root));
  const others = store.projectRoots().filter((root) => !known.has(root));
  return {
    user: store.read({ kind: 'user' }),
    projects: [...projects.map((p) => store.read({ kind: 'project', root: p.root }, p.name)), ...others.map((root) => store.read({ kind: 'project', root }))],
  };
};

/** Undo the memory write a marker on your own run's card stands for (BLG-102), and mark it undone. */
export const undoMemoryMark = (s: Pick<Session, 'store'>, channel: string, itemId: string, markId: string, store: MemoryStore = new MemoryStore()): MemoryView => {
  const { log, selfId } = s.store.getState();
  const item = log.find((l) => l.type === 'agent' && l.channel === channel && l.id === itemId && l.owner === selfId);
  const mark = item?.type === 'agent' ? item.learned?.find((m) => m.id === markId) : undefined;
  if (!mark || mark.kind !== 'memory') throw new MemoryError('That memory change isn’t in this conversation any more.');
  if (mark.undone !== undefined) throw new MemoryError('That was undone already.');
  const view = store.undo(mark.change);
  s.store.dispatch({ type: 'agent_learned_undone', itemId, markId, at: Date.now() });
  return view;
};

export const MEMORY_HANDLERS = {
  'memory.list': (s) => overview(s, new MemoryStore()),
  'memory.add': (_s, scope, text) => new MemoryStore().add(scope, text, 'you'),
  'memory.replace': (_s, scope, entry, text) => new MemoryStore().replace(scope, entry, text, 'you'),
  'memory.remove': (_s, scope, entry) => new MemoryStore().remove(scope, entry),
  'memory.file': (_s, scope, entry, filed) => new MemoryStore().write(scope, { op: 'file', entry, filed }, 'you').view,
  'memory.undo': (s, channel, itemId, markId) => undoMemoryMark(s, channel, itemId, markId),
  'memory.keepProposal': (s, id) => reflectionOf(s).keep(id),
  'memory.discardProposal': (s, id) => reflectionOf(s).discard(id),
  'memory.rejectProposal': (s, id) => reflectionOf(s).reject(id),
  'memory.reflect': (s, channel) => reflectionOf(s).reflect(channel, 'manual'),
  'memory.tidy': (s) => reflectionOf(s).tidy(),
} satisfies MemoryHandlers;
