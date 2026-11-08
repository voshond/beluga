import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { type UiState, initialUi } from '@beluga/ui/keymap.js';
import type { MenuKind } from '@beluga/ui/menus.js';
import { onWindowActive, windowActive } from './window-active.js';
import { SAVING_DRAW_MS, powerSaving } from './power.js';
import type { SettingsPane } from './settings-search.js';

/**
 * This window's own UI state. It uses the shared shape (UiState) for everything the
 * shared menus and actions touch (an open menu, the composer's text, what it's asking for),
 * plus a few things only this window has.
 */
export interface MacUi extends UiState {
  /** A query for the Search page to take up (the sidebar's field searched it, or See All opens it). */
  searchQuery?: string;
  readonly palette: boolean;
  /** The Add Project sheet is open ('new': on Start new, to make a new project). */
  readonly addProject?: boolean | 'new';
  /**
   * A project unfolded by clicking its row: it folds again when you go elsewhere, unless you
   * opened one of its worktrees or chats (then it stays open).
   */
  readonly peek?: string;
  /** The notification centre (the bell in the toolbar) is open. */
  readonly notices: boolean;
  readonly settings?: SettingsPane;
  /** A sheet asking for one line of text (a name for a new group…). */
  readonly ask?: { readonly title: string; readonly placeholder: string; readonly onSubmit: (text: string) => void };
  /** Who the next message is for (a chip in the composer): a person, their Claude, or yours. */
  readonly to?: Recipient;
}

/** "To bob", "To bob's Claude", "To your Claude": the message goes to them (see recipientPrefix). */
export interface Recipient {
  readonly peerId: string;
  readonly name: string;
  readonly claude: boolean;
  /** Yourself (your own Claude). */
  readonly self?: boolean;
}

/** What a message addressed to `to` starts with when it's sent (how Beluga reads who it's for). */
export const recipientPrefix = (to: Recipient): string => (to.claude ? (to.self ? '@claude ' : `@claude:${to.name} `) : `@${to.name} `);

/** "bob's Claude", "your Claude", "bob". */
export const recipientLabel = (to: Recipient): string => (to.claude ? (to.self ? 'your agent' : `${to.name}’s agent`) : to.name);

export type { SettingsPane };

type Listener = () => void;

export class UiStore {
  private state: MacUi = { ...initialUi, palette: false, notices: false };
  private readonly listeners = new Set<Listener>();

  get = (): MacUi => this.state;

  patch = (patch: Partial<MacUi>): void => {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  };

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  openMenu = (menu: MenuKind): void => this.patch({ menu: { menu, selected: 0 } });
}

interface Beluga {
  readonly client: SocketClient;
  readonly ui: UiStore;
}

const Ctx = createContext<Beluga | null>(null);

export function BelugaProvider({ client, children }: { client: SocketClient; children: ReactNode }) {
  const ui = useRef(new UiStore()).current;
  const value = useMemo(() => ({ client, ui }), [client, ui]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The same, or undefined outside a BelugaProvider (parts that also draw in previews and tests). */
export function useMaybeBeluga(): Beluga | undefined {
  return useContext(Ctx) ?? undefined;
}

export function useBeluga(): Beluga {
  const k = useContext(Ctx);
  if (!k) throw new Error('useBeluga outside BelugaProvider');
  return k;
}

/** While you're not looking at Beluga, views catch up with the shared state at most this often. */
const AWAY_MS = 1000;
const views = new WeakMap<object, (listener: () => void) => () => void>();

/**
 * How this window's views hear the shared state change: while you're looking at Beluga, once a
 * frame (a burst of events, a streamed answer's words, is drawn once, in the next frame, as it
 * would have been anyway); while you're not (lib/window-active.ts), at most once a second, so a
 * Claude streaming for hours doesn't redraw a window nobody's watching (KLD-40). Looking back
 * catches up at once. The state itself is applied at once (getState is always current); only
 * the views' redraws wait. The Dock, tray and notifications listen to the store itself and never wait.
 */
function viewSubscribe(store: { subscribe: (listener: () => void) => () => void }): (listener: () => void) => () => void {
  const known = views.get(store);
  if (known) return known;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    clearTimeout(soon);
    soon = undefined;
    for (const l of [...listeners]) l();
  };
  store.subscribe(() => {
    if (!windowActive()) {
      timer ??= setTimeout(flush, AWAY_MS);
      return;
    }
    // Low Power mode (BLG-621): what changed is drawn a few times a second, not every frame.
    if (powerSaving()) {
      timer ??= setTimeout(flush, SAVING_DRAW_MS);
      return;
    }
    if (frame !== undefined || soon !== undefined) return;
    // A hidden page draws no frames (WebKit's "hidden" can be stale while you look, KLD-64): a timer then.
    if (document.hidden) soon = setTimeout(flush, 0);
    else frame = requestAnimationFrame(flush);
  });
  onWindowActive(() => {
    if (windowActive() && timer) flush();
  });
  // Hidden with a frame still to come (it wouldn't): now instead.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && frame !== undefined) flush();
  });
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  views.set(store, subscribe);
  return subscribe;
}

/**
 * The shared state seen through this window (re-renders when the picked part changes). A pick
 * that builds something new each time (a filtered list) passes `equal` (e.g. sameItems, lib/stable.ts):
 * while it says the new pick is the same, the view keeps the old one and isn't drawn again.
 */
export function useApp<T>(pick: (s: AppState) => T, equal?: (a: T, b: T) => boolean): T {
  const { client } = useBeluga();
  const last = useRef<{ readonly value: T } | undefined>(undefined);
  return useSyncExternalStore(viewSubscribe(client.store), () => {
    const next = pick(client.store.getState());
    if (!equal) return next;
    if (last.current && equal(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  });
}

/** useApp outside a BelugaProvider too: `fallback` there. */
export function useMaybeApp<T>(pick: (s: AppState) => T, fallback: T): T {
  const store = useContext(Ctx)?.client.store;
  return useSyncExternalStore(store ? viewSubscribe(store) : noSubscribe, () => (store ? pick(store.getState()) : fallback));
}
const noSubscribe = (): (() => void) => () => undefined;

export function useUi<T>(pick: (s: MacUi) => T): T {
  const { ui } = useBeluga();
  return useSyncExternalStore(ui.subscribe, () => pick(ui.get()));
}

export const useApi = () => useBeluga().client.api;

/** Say something briefly in this window. */
export function toast(client: SocketClient, text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  client.store.dispatch({ type: 'toast', text, level });
}
