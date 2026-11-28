import { useEffect, useState } from 'react';
import { useApp, useBeluga } from './beluga.js';
import { type ProjectsView, nextViewChangeIn, projectsStateOf, projectsViewOf } from './projects-state-model.js';

// When this window first saw each Beluga's projects loading: every place counts from the same
// moment, so they all change together and one drawn later doesn't start waiting again.
const since = new WeakMap<object, number>();

/**
 * Whether this computer's projects are here, on their way, or really none (projects-state-model.ts).
 * Ask this wherever "no projects" is decided, instead of reading `projects.length`.
 */
export function useProjectsState(): ProjectsView {
  const { client } = useBeluga();
  const state = useApp(projectsStateOf);
  const [, redraw] = useState(0);
  let from = since.get(client.store);
  if (state === 'loading' && from === undefined) since.set(client.store, (from = Date.now()));
  const waited = state === 'loading' && from !== undefined ? Date.now() - from : 0;
  const next = nextViewChangeIn(state, waited);
  useEffect(() => {
    if (next === undefined) return;
    const t = setTimeout(() => redraw((n) => n + 1), next);
    return () => clearTimeout(t);
  }, [next]);
  return projectsViewOf(state, waited);
}
