/**
 * Whether this computer has projects, told apart from "Beluga hasn't looked yet". A window attaches
 * while the first scan of the project folders is still running: the state says no projects, and
 * means "not known yet". Every place that would say "add a project" asks here first, so none of
 * them says it while your projects are on their way.
 */

/** `loading`: the first scan isn't done and nothing's here yet. `empty`: looked, and there are none. */
export type ProjectsState = 'loading' | 'empty' | 'ready';

/**
 * What a place that depends on the projects draws: `pending` is `loading` in its first moments,
 * when nothing is drawn at all (neither "add a project" nor a skeleton), so a fast start never
 * flashes one.
 */
export type ProjectsView = ProjectsState | 'pending';

/** A scan this quick shows no loading state at all. */
export const LOADING_SHOWS_AFTER_MS = 150;

interface Known {
  /** Chats (no folder of its own) isn't a project you added: only ones with a root count. */
  readonly projects: ReadonlyArray<{ readonly root: string }>;
  readonly projectsLoaded: boolean;
}

/** Projects already here are `ready` whatever the scan says: the list only ever fills in. */
export function projectsStateOf(state: Known): ProjectsState {
  if (state.projects.some((p) => p.root)) return 'ready';
  return state.projectsLoaded ? 'empty' : 'loading';
}

/**
 * What to draw, `waitedMs` after this window first saw the projects loading. It stays `loading`
 * however long the scan takes (many projects on a busy disk take over a minute): giving up and
 * saying "add a project" then is the very thing this is here to stop.
 */
export function projectsViewOf(state: ProjectsState, waitedMs: number): ProjectsView {
  if (state !== 'loading') return state;
  return waitedMs < LOADING_SHOWS_AFTER_MS ? 'pending' : 'loading';
}

/** How long until `projectsViewOf` answers differently for the same state (undefined: it won't). */
export function nextViewChangeIn(state: ProjectsState, waitedMs: number): number | undefined {
  return state === 'loading' && waitedMs < LOADING_SHOWS_AFTER_MS ? LOADING_SHOWS_AFTER_MS - waitedMs : undefined;
}

/** True while the projects aren't known yet: say nothing about there being none. */
export const stillLoading = (view: ProjectsView): boolean => view === 'loading' || view === 'pending';
