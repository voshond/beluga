import { useEffect, useSyncExternalStore } from 'react';
import type { AppState, View } from '@beluga/core/store.js';

/** What the panel needs to know about the window: what's on screen and the projects. */
export type PanelState = Pick<AppState, 'view' | 'projects'>;
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { DEFAULT_LAYOUT, PANES_DEFAULT, type PaneId, type PanelTab, drawerFits, moveTab, panelFits, paneKey, paneOf, paneTabs, panelTabsFor, pickPanelTab, rememberTab, viewsOf } from './panel-model.js';
import { type UiPrefs, getPrefs, setPrefs } from './prefs.js';

/**
 * The right panel and the terminal drawer, as the window uses them: which tab shows, showing a
 * tab from anywhere (Run shows the terminal, a file link shows Files), ⌘J, and the focus view
 * (a diff or a file across the whole center for a while, Esc goes back to the chat).
 */

export type FocusKind = 'diff' | 'file' | 'terminal' | 'pr';

interface Runtime {
  /** The center shows this instead of the chat (for this workspace only). */
  readonly focus?: { readonly kind: FocusKind; readonly wsId: string };
  /** When the keyboard was last asked to go to the terminal (⌘J): the terminal that shows takes it. */
  readonly termFocus: number;
  /** What the panel showed before ⌘J brought the terminal up (⌘J again goes back), and where. */
  readonly before?: { readonly key: string; readonly tab: PanelTab; readonly closed: boolean; readonly bottomClosed: boolean };
  /**
   * The panel was open when a file or a diff took the center: it steps aside for the focus view
   * and comes back with Esc. Showing or hiding it yourself meanwhile forgets this (your choice stays).
   */
  readonly panelBack?: boolean;
  /** An Android phone is paired: the panel has its Phone tab (BLG-186). */
  readonly phone?: boolean;
}

let runtime: Runtime = { termFocus: 0 };
const listeners = new Set<() => void>();
const patch = (next: Partial<Runtime>): void => {
  runtime = { ...runtime, ...next };
  for (const l of [...listeners]) l();
};

export function usePanelRuntime<T>(pick: (r: Runtime) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pick(runtime),
  );
}

const workspaceOf = (state: PanelState): Workspace | undefined => (state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined);

/** The folder the Files tab (and a file opened in full) is about: the workspace on screen, or on a project's page its main folder. */
export function filesWsOf(state: PanelState): string | undefined {
  const { view } = state;
  if (view.kind === 'workspace') return view.id;
  if (view.kind === 'project') return state.projects.find((p) => p.id === view.id)?.workspaces.find((w) => w.kind === 'main' && !w.archived)?.id;
  return undefined;
}

/** Uncommitted files or commits ahead of its base. */
export const hasChanges = (ws: Workspace | undefined): boolean => (ws?.status?.changed ?? 0) + (ws?.status?.ahead ?? 0) > 0;

export const tabsOf = (state: PanelState): PanelTab[] => panelTabsFor(state.view, workspaceOf(state)?.kind, runtime.phone).filter((t) => t !== 'scratch' || getPrefs().scratchTab);

/** Whether a phone is paired, so the panel offers its Phone tab (set from the shared state as it changes). */
export const setPhoneTab = (on: boolean): void => {
  if (Boolean(runtime.phone) !== on) patch({ phone: on });
};

/** A pane's tabs for what's on screen, in your order. */
export const paneTabsOf = (state: PanelState, pane: PaneId, prefs: UiPrefs = getPrefs()): PanelTab[] => paneTabs(prefs.panelLayout, pane, tabsOf(state));

/** The tab a pane shows (or would, while hidden): the one you last picked there, else Changes when there are changes, else Info. */
export function currentTab(state: PanelState, prefs: UiPrefs = getPrefs(), pane: PaneId = 'top'): PanelTab | undefined {
  const tabs = paneTabsOf(state, pane, prefs);
  if (!tabs.length) return undefined;
  // History is Changes' second view: a pane with Changes can show it.
  const views = tabs.flatMap((t) => viewsOf(t, tabsOf(state)));
  return pickPanelTab(views, prefs.panelTabs[paneKey(state.view, pane)], hasChanges(workspaceOf(state)));
}

/** The pane is on screen: the panel is open, it has tabs here, and (the bottom one) it's open. */
export function paneShowing(state: PanelState, pane: PaneId, prefs: UiPrefs = getPrefs()): boolean {
  return prefs.inspector && paneTabsOf(state, pane, prefs).length > 0 && (pane === 'top' || prefs.bottomOpen || !paneTabsOf(state, 'top', prefs).length);
}

/** This tab is on screen right now. */
export function tabShowing(state: PanelState, tab: PanelTab, prefs: UiPrefs = getPrefs()): boolean {
  const pane = paneOf(prefs.panelLayout, tab);
  return paneShowing(state, pane, prefs) && currentTab(state, prefs, pane) === tab;
}

/** Pick a tab (remembered for this workspace, in its pane). */
export function setPanelTab(view: View, tab: PanelTab): void {
  patch({ before: undefined });
  const prefs = getPrefs();
  const pane = paneOf(prefs.panelLayout, tab);
  setPrefs({ panelTabs: rememberTab(prefs.panelTabs, paneKey(view, pane), tab), ...(pane === 'bottom' ? { bottomOpen: true } : {}) });
}

/** You showed or hid the panel yourself: during a focus view, that's what stays after it. */
const panelChosen = (): void => {
  if (runtime.focus && runtime.panelBack !== undefined) patch({ panelBack: undefined });
};

/** Show the panel on this tab (opening its pane). False when the view has no such tab. */
export function showPanelTab(state: PanelState, tab: PanelTab): boolean {
  if (!tabsOf(state).includes(tab)) return false;
  panelChosen();
  patch({ before: undefined });
  const prefs = getPrefs();
  const pane = paneOf(prefs.panelLayout, tab);
  setPrefs({ inspector: true, panelTabs: rememberTab(prefs.panelTabs, paneKey(state.view, pane), tab), ...(pane === 'bottom' ? { bottomOpen: true } : {}) });
  return true;
}

/** Drag a tab to the other pane (or along its own): it stays there, and shows. */
export function placeTab(state: PanelState, tab: PanelTab, to: PaneId, before?: PanelTab): void {
  const prefs = getPrefs();
  const panelLayout = moveTab(prefs.panelLayout, tab, to, before);
  setPrefs({ panelLayout, panelTabs: rememberTab(prefs.panelTabs, paneKey(state.view, to), tab), ...(to === 'bottom' ? { bottomOpen: true } : {}) });
}

export const resetPanelLayout = (): void => setPrefs({ panelLayout: DEFAULT_LAYOUT, paneSplit: PANES_DEFAULT, bottomOpen: true });

/** A changed file the Changes tab should open when it next shows (asked from the Files tab). */
let changeAsk: { readonly wsId: string; readonly path: string; readonly at: number } | undefined;
/** Asked a moment ago, or not at all (a later visit to Changes opens on its own). */
const ASK_MS = 2000;

/** Show a file's changes: the Changes tab, with that file's diff open. */
export function showChange(state: PanelState, path: string): boolean {
  if (state.view.kind !== 'workspace') return false;
  changeAsk = { wsId: state.view.id, path, at: Date.now() };
  if (showPanelTab(state, 'changes')) return true;
  changeAsk = undefined;
  return false;
}

/** The file to open (for this workspace's Changes tab). Read it while rendering, then forget it. */
export const peekChangeAsk = (wsId: string): string | undefined => (changeAsk?.wsId === wsId && Date.now() - changeAsk.at < ASK_MS ? changeAsk.path : undefined);
export const forgetChangeAsk = (): void => void (changeAsk = undefined);

/** The event a plan's page listens for: ⌥⌘0 there shows and hides its chat (its right side). */
export const PLAN_CHAT_TOGGLE = 'beluga:plan-chat';

export const togglePanel = (view: View): void => {
  if (view.kind === 'plan') return void document.dispatchEvent(new CustomEvent(PLAN_CHAT_TOGGLE));
  if (!panelFits(view)) return;
  panelChosen();
  setPrefs({ inspector: !getPrefs().inspector });
};

/** The terminal is on screen: in the drawer, or as the panel's tab. */
export function terminalShowing(state: PanelState, prefs: UiPrefs = getPrefs()): boolean {
  return (prefs.drawer && drawerFits(state.view)) || tabShowing(state, 'terminal', prefs);
}

/** Put the keyboard in the terminal that's showing. */
export const focusTerminal = (): void => patch({ termFocus: Date.now() });

/**
 * Show the terminal where you keep it (Settings › Terminal: the drawer or the panel). Run uses
 * it too, without taking the keyboard from the message box.
 */
export function revealTerminal(state: PanelState, focus: boolean): boolean {
  const prefs = getPrefs();
  const inDrawer = (prefs.termIn === 'drawer' || !tabsOf(state).includes('terminal')) && drawerFits(state.view);
  if (inDrawer) {
    if (!prefs.drawer) setPrefs({ drawer: true });
  } else if (tabsOf(state).includes('terminal')) {
    if (!tabShowing(state, 'terminal', prefs)) {
      const pane = paneOf(prefs.panelLayout, 'terminal');
      const tab = currentTab(state, prefs, pane) ?? 'terminal';
      const before = { key: paneKey(state.view, pane), tab, closed: !prefs.inspector, bottomClosed: !prefs.bottomOpen };
      panelChosen();
      setPrefs({ inspector: true, panelTabs: rememberTab(prefs.panelTabs, paneKey(state.view, pane), 'terminal'), ...(pane === 'bottom' ? { bottomOpen: true } : {}) });
      patch({ before });
    }
  } else return false;
  if (focus) focusTerminal();
  return true;
}

/** Put the terminal away: close the drawer, or give the panel back what it showed before. */
export function hideTerminal(state: PanelState): void {
  const prefs = getPrefs();
  const pane = paneOf(prefs.panelLayout, 'terminal');
  const key = paneKey(state.view, pane);
  const inDrawer = prefs.drawer && drawerFits(state.view);
  // With the drawer open, the panel's Terminal tab only points at it: closing the drawer is enough.
  const inPanel = !inDrawer && tabShowing(state, 'terminal', prefs);
  if (!inPanel && !inDrawer) return;
  // The panel goes back to what it showed before ⌘J (here, not in another workspace).
  const before = runtime.before?.key === key ? runtime.before : undefined;
  patch({ before: undefined });
  if (inPanel && pane === 'bottom') {
    // Below the rest: the bottom pane closes (back to what it showed, if ⌘J switched it).
    const back = before && before.tab !== 'terminal' ? before.tab : undefined;
    setPrefs({
      ...(inDrawer ? { drawer: false } : {}),
      ...(back ? { panelTabs: rememberTab(prefs.panelTabs, key, back), bottomOpen: !before?.bottomClosed } : { bottomOpen: false }),
      ...(before?.closed ? { inspector: false } : {}),
    });
    return;
  }
  const back = before && before.tab !== 'terminal' ? before.tab : (paneTabsOf(state, pane, prefs).find((t) => t !== 'terminal') ?? 'info');
  setPrefs({
    ...(inDrawer ? { drawer: false } : {}),
    // Closing the drawer mustn't leave the terminal showing in the panel instead.
    ...(inPanel ? { inspector: before ? !before.closed : true, panelTabs: rememberTab(prefs.panelTabs, key, back) } : {}),
  });
}

/** The keyboard is in a terminal. */
const typingInTerminal = (): boolean => Boolean(document.activeElement?.closest('.xterm'));

/**
 * ⌘J: show the terminal and type in it; already showing, just type in it; already typing in it,
 * put it away. Returns why not, when it can't.
 */
export function toggleTerminal(state: PanelState): string | undefined {
  const prefs = getPrefs();
  // Kept in the drawer: the drawer is the terminal ⌘J means (the panel's tab is just a tab then).
  const showing = prefs.termIn === 'drawer' && drawerFits(state.view) ? prefs.drawer && drawerFits(state.view) : terminalShowing(state, prefs);
  if (showing) {
    if (typingInTerminal()) hideTerminal(state);
    else focusTerminal();
    return undefined;
  }
  if (state.view.kind === 'shared') return 'A shared workspace’s terminal is its owner’s';
  if (state.view.kind === 'terminal') return undefined;
  return revealTerminal(state, true) ? undefined : 'No terminal here';
}

/** Move the terminal to the other place (and keep it there for ⌘J). */
export function moveTerminal(state: PanelState, to: 'drawer' | 'panel'): void {
  if (to === 'drawer') {
    const prefs = getPrefs();
    const panelHadIt = tabShowing(state, 'terminal', prefs);
    if (panelHadIt) hideTerminal(state);
    setPrefs({ termIn: 'drawer', drawer: true });
  } else {
    setPrefs({ termIn: 'panel', drawer: false });
    revealTerminal(state, false);
  }
}

/**
 * A diff, a file or the terminal across the center. The panel steps aside meanwhile (it would
 * only show a smaller copy of the same thing) and comes back when you go back to the chat.
 */
export function openFocus(kind: FocusKind, wsId: string): void {
  const open = getPrefs().inspector;
  // Already focused (another file, the diff after the file): keep what the panel was before all of it.
  const panelBack = runtime.focus && runtime.panelBack !== undefined ? runtime.panelBack : open;
  patch({ focus: { kind, wsId }, panelBack });
  if (open) setPrefs({ inspector: false });
}

export function closeFocus(): void {
  if (!runtime.focus) return;
  const back = runtime.panelBack;
  patch({ focus: undefined, panelBack: undefined });
  if (back && !getPrefs().inspector) setPrefs({ inspector: true });
}

/** Whether you have the panel open: while a file or a diff takes the center, what it comes back to. */
export const panelChosenOpen = (prefs: UiPrefs = getPrefs()): boolean => (runtime.focus && runtime.panelBack !== undefined ? runtime.panelBack : prefs.inspector);

export const focusFor = (wsId: string | undefined): FocusKind | undefined => (wsId && runtime.focus?.wsId === wsId ? runtime.focus.kind : undefined);

// A key press can reach both the window and the menu bar (its item has the same key), in either
// order: a toggle must run once. Whichever comes second within a moment is the echo.
const ran = new Map<string, { readonly by: 'key' | 'menu'; readonly at: number }>();
const ECHO_MS = 300;

function dedupe(by: 'key' | 'menu', id: string, run: () => void): void {
  const last = ran.get(id);
  const now = Date.now();
  if (last && last.by !== by && now - last.at < ECHO_MS) return;
  ran.set(id, { by, at: now });
  run();
}

export const byKey = (id: string, run: () => void): void => dedupe('key', id, run);
export const byMenu = (id: string, run: () => void): void => dedupe('menu', id, run);

/**
 * A workspace's Files, Diff and Terminal used to replace the chat. Whatever still asks for them
 * (Run, /review, a notification, "Open File" in a diff) now shows that tab in the panel (or the
 * terminal where you keep it), and the center stays on the conversation.
 */
export function useWorkspaceTabBridge(client: SocketClient): void {
  useEffect(() => {
    const check = (): void => {
      const state = client.store.getState();
      const view = state.view;
      if (view.kind !== 'workspace' || view.tab === 'chat') return;
      const chat: View = { ...view, tab: 'chat' };
      if (view.tab === 'review') showPanelTab({ ...state, view: chat }, 'changes');
      else if (view.tab === 'files') showPanelTab({ ...state, view: chat }, 'files');
      else revealTerminal({ ...state, view: chat }, false);
      client.store.dispatch({ type: 'view', view: chat });
    };
    check();
    return client.store.subscribe(check);
  }, [client]);
  // Somewhere else: the focus view was for the workspace you left.
  useEffect(
    () =>
      client.store.subscribe(() => {
        if (runtime.focus && filesWsOf(client.store.getState()) !== runtime.focus.wsId) closeFocus();
      }),
    [client],
  );
}
