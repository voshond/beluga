import type { View } from '../../../../src/core/store.js';
import { isSentinelView } from '../sentinel/sentinel-model.js';

/**
 * The right panel, as plain data: which tabs a view has, which one it opens on, how wide it may
 * get, and how older window preferences carry over. No DOM here, so it's tested on its own.
 */

export type PanelTab = 'changes' | 'files' | 'terminal' | 'info' | 'history' | 'scratch' | 'background' | 'phone';

/** Every tab in its fixed place: ⌥⌘1 is always Changes, ⌥⌘4 always Info, ⌥⌘5 History, ⌥⌘6 Scratch, ⌥⌘7 Background, ⌥⌘8 Phone. */
export const PANEL_TABS: readonly PanelTab[] = ['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background', 'phone'];

export const PANEL_LABELS: Record<PanelTab, string> = { changes: 'Changes', files: 'Files', terminal: 'Terminal', info: 'Info', history: 'History', scratch: 'Scratch', background: 'Background', phone: 'Phone' };

/**
 * The panel is two panes, one above the other, each with its own tabs: by default what Claude
 * made on top (Changes, Files, Scratch, Info) and what runs below (Terminal, Background). Drag a
 * tab to the other pane to keep it there. History is Changes' second view, not a tab of its own.
 */
export type PaneId = 'top' | 'bottom';
export interface PanelLayout {
  readonly top: readonly PanelTab[];
  readonly bottom: readonly PanelTab[];
}

/** The tabs with a place of their own (every one of them is in exactly one pane). */
export const SLOTS: readonly PanelTab[] = ['changes', 'files', 'scratch', 'info', 'terminal', 'background', 'phone'];
export const DEFAULT_LAYOUT: PanelLayout = { top: ['changes', 'files', 'scratch', 'info', 'phone'], bottom: ['terminal', 'background'] };

/** The tab a view lives in: History is inside Changes. */
export const slotOf = (tab: PanelTab): PanelTab => (tab === 'history' ? 'changes' : tab);

/** A saved layout made whole: each tab once, unknown ones dropped, missing ones back where they start. */
export function normalizeLayout(raw: unknown): PanelLayout {
  const read = (v: unknown): PanelTab[] => (Array.isArray(v) ? v.filter((t): t is PanelTab => SLOTS.includes(t as PanelTab)) : []);
  const r = (raw ?? {}) as { top?: unknown; bottom?: unknown };
  const top = [...new Set(read(r.top))];
  const bottom = [...new Set(read(r.bottom))].filter((t) => !top.includes(t));
  for (const slot of SLOTS) {
    if (top.includes(slot) || bottom.includes(slot)) continue;
    (DEFAULT_LAYOUT.bottom.includes(slot) ? bottom : top).push(slot);
  }
  return { top, bottom };
}

export const paneOf = (layout: PanelLayout, tab: PanelTab): PaneId => (layout.bottom.includes(slotOf(tab)) ? 'bottom' : 'top');

/** Move a tab into a pane, before `before` there (at the end without one). */
export function moveTab(layout: PanelLayout, tab: PanelTab, to: PaneId, before?: PanelTab): PanelLayout {
  const slot = slotOf(tab);
  const without = { top: layout.top.filter((t) => t !== slot), bottom: layout.bottom.filter((t) => t !== slot) };
  const list = [...without[to]];
  const at = before ? list.indexOf(slotOf(before)) : -1;
  list.splice(at < 0 ? list.length : at, 0, slot);
  return { ...without, [to]: list };
}

/** A pane's tabs for what's on screen (a project's home has History where Changes would be). */
export function paneTabs(layout: PanelLayout, pane: PaneId, available: readonly PanelTab[]): PanelTab[] {
  return layout[pane].flatMap((slot) => (available.includes(slot) ? [slot] : slot === 'changes' && available.includes('history') ? ['history' as const] : []));
}

/** The views a tab switches between at its top (Changes · History), or just itself. */
export function viewsOf(tab: PanelTab, available: readonly PanelTab[]): PanelTab[] {
  return slotOf(tab) === 'changes' ? (['changes', 'history'] as const).filter((t) => available.includes(t)) : [tab];
}

/** Where a pane's last tab is remembered: per workspace (and pane), one for everything else. */
export const paneKey = (view: View, pane: PaneId): string => (pane === 'top' ? panelKey(view) : `${panelKey(view)}|bottom`);

export const PANEL_MIN = 320;
export const PANEL_DEFAULT = 384;
/** The panel never takes more than this share of the window. */
export const PANEL_MAX_SHARE = 0.6;

/** How much of the panel's height the top pane takes, by default. */
export const PANES_DEFAULT = 0.58;

export const SPLIT_MIN = 0.18;
export const SPLIT_MAX = 0.75;
export const SPLIT_DEFAULT = 0.4;

export const DRAWER_MIN = 0.18;
export const DRAWER_MAX = 0.75;
export const DRAWER_DEFAULT = 0.36;

/** How many workspaces' last tabs are remembered (the oldest are forgotten). */
export const REMEMBERED_TABS = 100;

export type TerminalPlace = 'drawer' | 'panel';

/** What kind of workspace (a chat has no git, so no Changes). */
type WsKind = 'chat' | 'main' | 'worktree' | string;

/**
 * The panel's tabs for what's on screen, in their fixed order. With a phone paired (`phone`), its
 * live mirror is a tab beside Your Mac's chat (BLG-186), where Ask Claude on the Phone page takes
 * you. Not beside a project's chats: nothing there is about the phone.
 */
export function panelTabsFor(view: View, wsKind?: WsKind, phone = false): PanelTab[] {
  const tabs = tabsOfView(view, wsKind);
  return phone && tabs.length && view.kind === 'assistant' ? [...tabs, 'phone'] : tabs;
}

function tabsOfView(view: View, wsKind?: WsKind): PanelTab[] {
  // Scratch: what Claude saves to the workspace's .beluga/scratch/ while it works, live.
  // Background: the commands Claude and its agents run there in the background (dev servers, tests), live.
  if (view.kind === 'workspace') return wsKind === 'chat' ? ['files', 'terminal', 'info', 'scratch', 'background'] : PANEL_TABS.filter((t) => t !== 'phone');
  // A project's home (and its History page): its main folder's Files, and the project's history too.
  if (view.kind === 'project') return ['files', 'terminal', 'info', 'history'];
  // A plan's page is the plan and its chat, side by side; the Tasks board, a task's page and the plans have the whole window.
  if (!panelFits(view)) return [];
  // A shared workspace's shell is its owner's (its Scratch you see, read over the link); the Terminal view is already all shells.
  if (view.kind === 'shared') return ['info', 'scratch'];
  if (view.kind === 'terminal') return ['info'];
  // Your Mac's chat: its scratch folder too, which all its chats share (BLG-704).
  if (view.kind === 'assistant') return ['terminal', 'info', 'scratch'];
  return ['terminal', 'info'];
}

/**
 * The right panel shows beside this view: not on a plan's page (its right side is its chat), nor
 * on the Tasks board, a task's page, the plans or Sentinel's pages: nothing in it is about them, so they get the whole window.
 */
const WHOLE_WINDOW: ReadonlySet<View['kind']> = new Set(['plan', 'plans', 'tasks', 'task', 'gh_issue', 'gh_run']);
export const panelFits = (view: View): boolean => !WHOLE_WINDOW.has(view.kind) && !isSentinelView(view.kind);

/** Where a view's last tab is remembered: per workspace, one for everything else. */
export const panelKey = (view: View): string => (view.kind === 'workspace' ? `ws:${view.id}` : 'app');

/** The tab to show: the one you last picked here, else Changes when there are changes, else Info. */
export function pickPanelTab(tabs: readonly PanelTab[], remembered: PanelTab | undefined, hasChanges: boolean): PanelTab {
  if (remembered && tabs.includes(remembered)) return remembered;
  if (hasChanges && tabs.includes('changes')) return 'changes';
  return tabs.includes('info') ? 'info' : (tabs[0] ?? 'info');
}

/** Remember a tab for a place, forgetting the oldest beyond REMEMBERED_TABS. */
export function rememberTab(map: Readonly<Record<string, PanelTab>>, key: string, tab: PanelTab): Record<string, PanelTab> {
  const rest = Object.entries(map).filter(([k]) => k !== key);
  return Object.fromEntries([...rest.slice(Math.max(0, rest.length - REMEMBERED_TABS + 1)), [key, tab]]);
}

/**
 * The room the center (the conversation and its toolbar) always keeps beside the panel: its name
 * gives way to … first, down to this, and then the panel stops growing instead of covering it.
 */
export const CENTER_MIN = 690;

/**
 * The panel's width for a window this wide: at least PANEL_MIN, at most PANEL_MAX_SHARE of it,
 * and never so wide that the center (beside a sidebar `sidebarWidth` wide) gets under CENTER_MIN.
 */
export function clampPanelWidth(width: number, windowWidth: number, sidebarWidth = 0): number {
  const max = Math.max(PANEL_MIN, Math.min(Math.floor(windowWidth * PANEL_MAX_SHARE), windowWidth - sidebarWidth - CENTER_MIN));
  return Math.round(Math.min(max, Math.max(PANEL_MIN, width)));
}

export const clampShare = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

/** The bottom drawer works under any conversation or page, but not over the Terminal view or a friend's workspace. */
export const drawerFits = (view: View): boolean => view.kind !== 'terminal' && view.kind !== 'shared';

/** The ⌥⌘ digit for a tab (1–8). */
export const panelDigit = (tab: PanelTab): number => PANEL_TABS.indexOf(tab) + 1;

/**
 * Preferences saved by earlier versions, brought up to date. The terminal used to dock beside
 * the chat (`dock: 'right'`) or under it (`'bottom'`): beside becomes the right panel's Terminal
 * tab, under becomes the bottom drawer (kept open, at the same height).
 */
export function migratePrefs(raw: Record<string, unknown>): Record<string, unknown> {
  if (!('dock' in raw) && !('dockSize' in raw)) return raw;
  const { dock, dockSize, ...rest } = raw;
  const next: Record<string, unknown> = { ...rest };
  if (dock === 'right') next.termIn ??= 'panel';
  if (dock === 'bottom') {
    next.termIn ??= 'drawer';
    next.drawer ??= true;
  }
  if (typeof dockSize === 'number' && next.drawerSize === undefined) next.drawerSize = clampShare(dockSize, DRAWER_MIN, DRAWER_MAX);
  return next;
}
