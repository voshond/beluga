import { buildMemoryAppend, memoryLines } from '../../agent/memory-prompt.js';
import type { MemoryTools } from '../../agent/types.js';
import { type MemoryChange, type MemoryKind, type MemoryScope, type MemoryView, filedEntries, relevantEntries } from '../../shared/memory.js';
import { MemoryError, type MemoryStore, type MemoryWriteOp } from './store.js';

export type MemoryProject = {
  readonly root: string;
  readonly name: string;
};

export type MemoryRun = {
  readonly brief: string;
  readonly tools: MemoryTools;
};

const SEARCH_RESULTS = 15;

const summary = (title: string, view: MemoryView): string => {
  const filed = filedEntries(view).length;
  return `${title} (${view.used} of ${view.cap} characters${filed ? `; ${filed} more filed away, ${view.filedUsed} of ${view.filedCap}` : ''}):\n${memoryLines(view)}`;
};

/**
 * What one of your own runs gets of Beluga's memory (BLG-95): the user's, and its project's when it
 * runs in one, with the filed-away entries `request` is about (BLG-123). `onChange` hears each write
 * the run makes (BLG-102: its card shows it, with Undo).
 */
export const memoryForRun = (store: MemoryStore, project?: MemoryProject, onChange?: (change: MemoryChange) => void, request = ''): MemoryRun => {
  const scopeOf = (kind: MemoryKind): MemoryScope => {
    if (kind === 'user') return { kind: 'user' };
    if (!project) throw new MemoryError('This run is not in a project: only memory about the user is kept here.');
    return { kind: 'project', root: project.root };
  };
  const titleOf = (kind: MemoryKind): string => (kind === 'user' ? 'Memory about the user' : `Memory of ${project?.name ?? 'this project'}`);
  const read = (kind: MemoryKind): MemoryView => store.read(scopeOf(kind), kind === 'project' ? project?.name : undefined);
  const write = (kind: MemoryKind, op: MemoryWriteOp, did: string): string => {
    const { view, change } = store.write(scopeOf(kind), op, 'agent');
    onChange?.(change);
    return `${did}. ${summary(titleOf(kind), view)}`;
  };
  const search = (query: string): string => {
    const kinds: MemoryKind[] = project ? ['user', 'project'] : ['user'];
    const found = kinds.flatMap((kind) => relevantEntries(read(kind).entries, query).map((e) => ({ kind, e })));
    if (!found.length) return `Nothing in memory about "${query}".`;
    return found
      .slice(0, SEARCH_RESULTS)
      .map(({ kind, e }) => `- [${e.id}] (${kind}${e.filed ? ', filed' : ''}) ${e.text}`)
      .join('\n');
  };

  return {
    brief: buildMemoryAppend(read('user'), project ? read('project') : undefined, request),
    tools: {
      list: () => [summary(titleOf('user'), read('user')), project ? summary(titleOf('project'), read('project')) : 'This run is not in a project: no project memory.'].join('\n\n'),
      add: (kind, text, filed) => write(kind, { op: 'add', text, ...(filed ? { filed } : {}) }, filed ? 'Filed away' : 'Remembered'),
      replace: (kind, entry, text) => write(kind, { op: 'replace', entry, text }, 'Replaced'),
      remove: (kind, entry) => write(kind, { op: 'remove', entry }, 'Removed'),
      file: (kind, entry, filed) => write(kind, { op: 'file', entry, filed }, filed ? 'Filed away' : 'Every run gets it again'),
      search,
    },
  };
};
