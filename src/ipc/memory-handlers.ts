import { MemoryStore } from '../core/memory/store.js';
import type { Session } from '../core/session.js';
import type { MemoryOverview } from '../shared/memory.js';
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

export const MEMORY_HANDLERS = {
  'memory.list': (s) => overview(s, new MemoryStore()),
  'memory.add': (_s, scope, text) => new MemoryStore().add(scope, text, 'you'),
  'memory.replace': (_s, scope, entry, text) => new MemoryStore().replace(scope, entry, text, 'you'),
  'memory.remove': (_s, scope, entry) => new MemoryStore().remove(scope, entry),
} satisfies MemoryHandlers;
