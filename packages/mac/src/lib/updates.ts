import { useEffect, useSyncExternalStore } from 'react';
import type { View } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { Actions } from './actions.js';
import { APP_VERSION, inApp } from './boot.js';
import { INITIAL_UPDATE_STATE, type SavedPlace, type UpdateMode, type UpdateState, activityOf, placeAction } from './update-model.js';

/**
 * Beluga's own updates in the window: a small store fed by the app shell (src-tauri/src/updater.rs
 * sends `update-state`), and what the buttons ask it to do. In a browser (development, the
 * end-to-end tests) there's no shell: a test seeds `window.__BELUGA_UPDATES__` before the page
 * loads, and every request is recorded in `window.__BELUGA_UPDATE_CALLS__` instead.
 */

declare global {
  interface Window {
    __BELUGA_UPDATES__?: Partial<UpdateState>;
    __BELUGA_UPDATE_CALLS__?: string[];
  }
}

export interface UpdatesSnapshot {
  readonly state: UpdateState;
  /** The update sheet is open. */
  readonly open: boolean;
  /** Claude runs working right now (the sheet warns before Restart Now stops them). */
  readonly claude: number;
}

let snap: UpdatesSnapshot = { state: { ...INITIAL_UPDATE_STATE, current: APP_VERSION }, open: false, claude: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<UpdatesSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of [...listeners]) l();
}

const patchState = (patch: Partial<UpdateState>): void => set({ state: { ...snap.state, ...patch } });

export function useUpdates(): UpdatesSnapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snap,
  );
}

let started = false;

/** Start listening to the app shell (once; called by the update layer). */
export function startUpdates(): void {
  if (started) return;
  started = true;
  if (!inApp()) {
    if (window.__BELUGA_UPDATES__) patchState(window.__BELUGA_UPDATES__);
    return;
  }
  void (async () => {
    const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
    await listen<UpdateState>('update-state', (e) => set({ state: e.payload }));
    await listen('update-show', () => set({ open: true }));
    set({ state: await invoke<UpdateState>('update_state') });
  })().catch(() => undefined);
}

async function ask(cmd: string, args: Record<string, unknown> | undefined, pretend: () => void): Promise<void> {
  if (!inApp()) {
    (window.__BELUGA_UPDATE_CALLS__ ??= []).push(args ? `${cmd} ${JSON.stringify(args)}` : cmd);
    pretend();
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  // What went wrong comes back as the state's error (the shell sends it), not here.
  await invoke(cmd, args).catch(() => undefined);
}

export const openUpdateSheet = (): void => set({ open: true });
export const closeUpdateSheet = (): void => set({ open: false });

export function checkForUpdates(): Promise<void> {
  return ask('update_check', undefined, () => patchState({ phase: snap.state.available ? 'ready' : 'current', lastCheck: Date.now(), error: null }));
}

export function setUpdateMode(mode: UpdateMode): Promise<void> {
  const off = mode === 'off';
  return ask('update_set_mode', { mode }, () => patchState({ mode, ...(off ? { available: null, choice: null } : mode === 'idle' && snap.state.available ? { choice: 'idle' } : {}) }));
}

/** Install now and reopen right where you are. */
export function restartNow(): Promise<void> {
  rememberPlace();
  return ask('update_choose', { choice: 'now' }, () => patchState({ phase: 'installing' }));
}

/** Install once you've stepped away and nothing is running. */
export function updateWhenIdle(): Promise<void> {
  set({ open: false });
  return ask('update_choose', { choice: 'idle' }, () => patchState({ choice: 'idle' }));
}

/** Install the next time you quit Beluga. */
export function updateLater(): Promise<void> {
  set({ open: false });
  return ask('update_choose', { choice: 'quit' }, () => patchState({ choice: 'quit' }));
}

export function dismissNews(): Promise<void> {
  set({ open: false });
  return ask('update_dismiss_news', undefined, () => patchState({ news: null }));
}

// ---- where you were, across Restart Now

const PLACE_KEY = 'beluga.relaunch.v1';
let currentView: View | undefined;

function rememberPlace(): void {
  if (!currentView) return;
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify({ view: currentView, at: Date.now() } satisfies SavedPlace));
  } catch {
    // No storage: you start where Beluga starts.
  }
}

function takePlace(): SavedPlace | undefined {
  try {
    const text = localStorage.getItem(PLACE_KEY);
    localStorage.removeItem(PLACE_KEY);
    return text ? (JSON.parse(text) as SavedPlace) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tell the app shell what's going on (Claude working, friends in the room) so "Update When
 * Idle" waits for it, and after Restart Now go back to where you were.
 */
export function useUpdateActivity(client: SocketClient, actions: Actions): void {
  useEffect(() => {
    let place = takePlace();
    let last = '';
    const update = (): void => {
      const st = client.store.getState();
      currentView = st.view;
      if (!st.selfId) return;
      if (place) {
        const go = placeAction(place, st);
        place = undefined;
        if (go) actions.run(go);
      }
      const activity = activityOf(st);
      const key = JSON.stringify(activity);
      if (key === last) return;
      last = key;
      set({ claude: activity.claude });
      if (inApp()) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('update_activity', { activity })).catch(() => undefined);
    };
    update();
    const off = client.store.subscribe(update);
    return () => {
      off();
      if (inApp()) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('update_activity', { activity: null })).catch(() => undefined);
    };
  }, [client]);
}
