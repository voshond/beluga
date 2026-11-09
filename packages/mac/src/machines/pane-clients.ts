import { useEffect, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { capabilities, connectMachine } from '../lib/boot.js';
import { UiStore } from '../lib/beluga.js';
import { zoom } from '../lib/prefs.js';
import type { Capabilities } from '@beluga/ipc/socket-client.js';
import { OnceEach, type RawNotice, machineNotice, noticeKey } from '@beluga/machines/attention.js';
import { dndActive } from '@beluga/shared/quiet.js';
import { currentMachines } from './use-machines.js';
import { watchLink } from './link-health.js';
import { everyWhileShown } from '../lib/window-active.js';

/**
 * This window's screens on your computers (BLG-784), one per computer, kept while the window runs:
 * going from a computer's page to this Mac's and back finds its chat, terminals and the pane's own
 * UI state as you left them. A dropped link is the daemon's to dial again (machines/door.ts); a
 * screen that ends (forgotten, this Mac's Beluga restarting) is opened again the next time it's shown.
 */

export interface MachinePaneState {
  readonly client?: SocketClient;
  /** Why it couldn't be reached, in words. */
  readonly error?: string;
  /** The pane's own UI state (the box's words, an open menu), with the window's parts read through. */
  readonly ui: UiStore;
}

interface Entry {
  state: MachinePaneState;
  /** This Mac's own screen (what a computer's page does on this Mac goes through it). */
  home?: SocketClient;
  /** The window it was opened for (a new window's, after this Mac's Beluga restarted, starts again). */
  readonly windowUi: UiStore;
  connecting?: Promise<void>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const IDLE: MachinePaneState = { ui: new UiStore() };

const emit = (): void => {
  for (const l of [...listeners]) l();
};

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function set(id: string, patch: Partial<MachinePaneState>): void {
  const entry = entries.get(id);
  if (!entry) return;
  const next: Record<string, unknown> = { ...entry.state, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  entry.state = next as unknown as MachinePaneState;
  emit();
}

/**
 * A computer's toasts (a call that failed there) show in this window's own: the window draws
 * toasts from this Mac's state only.
 */
function forwardToasts(client: SocketClient, home: SocketClient): () => void {
  let last = client.store.getState().toast;
  return client.store.subscribe(() => {
    const toast = client.store.getState().toast;
    if (toast === last) return;
    last = toast;
    if (toast) home.store.dispatch({ type: 'toast', text: toast.text, level: toast.level });
  });
}

const once = new OnceEach();

/**
 * What this window does for a computer's screen: as for this Mac's, but its notices come through
 * the one bell (BLG-790): once each, with the computer's name, tagged so opening or answering one
 * acts there, and not at all while Do Not Disturb is on here.
 */
function machineCaps(id: string, home: SocketClient): Capabilities {
  const base = capabilities(zoom);
  const notify = base.notify as ((raw: RawNotice) => Promise<void>) | undefined;
  if (!notify) return base;
  return {
    ...base,
    notify: async (raw: RawNotice) => {
      if (dndActive(home.store.getState().prefs.notify)) return;
      if (!once.first(noticeKey(id, raw))) return;
      const name = currentMachines().find((m) => m.id === id)?.name ?? 'Your computer';
      await notify(machineNotice({ id, name }, raw));
    },
  };
}

/** A screen nobody looks at: on a page with no conversation, and away. */
export function background(client: SocketClient): void {
  client.store.dispatch({ type: 'view', view: { kind: 'overview' } });
  client.store.dispatch({ type: 'away', away: true });
}

/** Open the screen on computer `id` unless one is open or opening. */
export function ensureMachine(id: string, home: SocketClient, windowUi: UiStore): void {
  let entry = entries.get(id);
  if (!entry || entry.windowUi !== windowUi) {
    entry?.state.client?.close();
    entry = { state: { ui: new UiStore(windowUi) }, windowUi };
    entries.set(id, entry);
  }
  entry.home = home;
  if (entry.state.client || entry.connecting) return;
  const mine = entry;
  set(id, { error: undefined });
  mine.connecting = connectMachine(id, machineCaps(id, home))
    .then((client) => {
      // This Mac's own screen went meanwhile (its Beluga restarted): this one goes with it.
      if (entries.get(id) !== mine) return client.close();
      const offToasts = forwardToasts(client, home);
      const offHome = home.onClose(() => client.close());
      // Pinged while the window can be seen: a link nobody's looking at isn't measured.
      const offLink = watchLink(id, client, everyWhileShown);
      client.onClose((reason) => {
        offToasts();
        offHome();
        offLink();
        if (entries.get(id) === mine && mine.state.client === client) set(id, { client: undefined, ...(reason === 'closed' ? {} : { error: reason }) });
      });
      // In the background until a pane shows it: looking at nothing there, so its chats stay unread and its notices come.
      background(client);
      set(id, { client });
    })
    .catch((err: unknown) => set(id, { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      mine.connecting = undefined;
    });
}

/** Try computer `id` again (after it couldn't be reached). */
export function retryMachine(id: string, home: SocketClient, windowUi: UiStore): void {
  const entry = entries.get(id);
  if (entry) entry.state = { ui: entry.state.ui };
  ensureMachine(id, home, windowUi);
  emit();
}

/** Hear screens open and close (the lists of every computer's work follow them). */
export const onMachines = subscribe;

/** Which computer a screen is on (and this Mac's own screen beside it); undefined for this Mac's. */
export function machineOfClient(client: object): { readonly id: string; readonly home: SocketClient } | undefined {
  for (const [id, e] of entries) if (e.state.client === client && e.home) return { id, home: e.home };
  return undefined;
}

/** The pane's own UI state for computer `id` (its sheets read through to the window's). */
export const machineUiOf = (id: string): UiStore | undefined => entries.get(id)?.state.ui;

/** The screen open on computer `id`, if it is. */
export const machineClientOf = (id: string): SocketClient | undefined => entries.get(id)?.state.client;

/** Close every computer's screen (this window's own went). */
export function closeMachines(): void {
  for (const entry of entries.values()) entry.state.client?.close();
  entries.clear();
  emit();
}

/** The screen on computer `id` for a pane: opened when it isn't, and redrawn as it comes and goes. */
export function useMachinePane(id: string, home: SocketClient, windowUi: UiStore): MachinePaneState {
  useEffect(() => ensureMachine(id, home, windowUi), [id, home, windowUi]);
  return useSyncExternalStore(subscribe, () => entries.get(id)?.state ?? IDLE);
}
