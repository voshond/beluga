import type { AppState } from '../../../../src/core/store.js';
import { isDescendant } from '../../../../src/core/threads/model.js';
import type { ThreadChildren } from '../../../../src/shared/threads.js';
import { threadNodes } from '../../../../src/ui/thread-tree.js';

export { threadFamily } from '../../../../src/ui/thread-tree.js';

/**
 * Which picked chats get their own call. With `with`, a chat under another picked chat goes in that
 * chat's cascade, so it gets no second call. With `keep`, or with no question asked, each one is its own.
 */
export function batchCalls(st: Pick<AppState, 'projects'>, ids: readonly string[], children: ThreadChildren | undefined): readonly string[] {
  if (children !== 'with') return ids;
  const nodes = threadNodes(st.projects.flatMap((p) => p.workspaces));
  return ids.filter((id) => !ids.some((other) => other !== id && isDescendant(nodes, `ws:${other}`, id)));
}
