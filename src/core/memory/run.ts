import { buildMemoryAppend, memoryLines } from '../../agent/memory-prompt.js';
import type { MemoryTools } from '../../agent/types.js';
import type { MemoryKind, MemoryScope, MemoryView } from '../../shared/memory.js';
import { MemoryError, type MemoryStore } from './store.js';

export type MemoryProject = {
  readonly root: string;
  readonly name: string;
};

export type MemoryRun = {
  readonly brief: string;
  readonly tools: MemoryTools;
};

const summary = (title: string, view: MemoryView): string => `${title} (${view.used} of ${view.cap} characters):\n${memoryLines(view)}`;

/** What one of your own runs gets of Beluga's memory (BLG-95): the user's, and its project's when it runs in one. */
export const memoryForRun = (store: MemoryStore, project?: MemoryProject): MemoryRun => {
  const scopeOf = (kind: MemoryKind): MemoryScope => {
    if (kind === 'user') return { kind: 'user' };
    if (!project) throw new MemoryError('This run is not in a project: only memory about the user is kept here.');
    return { kind: 'project', root: project.root };
  };
  const titleOf = (kind: MemoryKind): string => (kind === 'user' ? 'Memory about the user' : `Memory of ${project?.name ?? 'this project'}`);
  const read = (kind: MemoryKind): MemoryView => store.read(scopeOf(kind), kind === 'project' ? project?.name : undefined);
  const after = (kind: MemoryKind, view: MemoryView, did: string): string => `${did}. ${summary(titleOf(kind), view)}`;

  return {
    brief: buildMemoryAppend(read('user'), project ? read('project') : undefined),
    tools: {
      list: () => [summary(titleOf('user'), read('user')), project ? summary(titleOf('project'), read('project')) : 'This run is not in a project: no project memory.'].join('\n\n'),
      add: (kind, text) => after(kind, store.add(scopeOf(kind), text, 'agent'), 'Remembered'),
      replace: (kind, entry, text) => after(kind, store.replace(scopeOf(kind), entry, text, 'agent'), 'Replaced'),
      remove: (kind, entry) => after(kind, store.remove(scopeOf(kind), entry), 'Removed'),
    },
  };
};
