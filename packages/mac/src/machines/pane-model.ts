// Relative, not @beluga: the root's tests and typecheck read this file too.
import type { View } from '../../../../src/core/store.js';

/**
 * A page on one of your computers (BLG-784), as plain data. The window's own view says
 * `{ kind: 'machine', machine, view }`; the pane draws `view` with that computer's client (its
 * screen over /machine/<id>), and the two are kept in step both ways. The UI is always this app's:
 * only state and calls come from the computer. No DOM here (tests/mac-machine-pane.test.ts).
 */

/** A computer's device id, as the daemon's /machine/<id> takes it. */
const MACHINE_ID = /^[0-9a-f]{16}$/;

export const isMachineId = (id: string): boolean => MACHINE_ID.test(id);

/** `view` on computer `machine` (a page already on one stays on its own). */
export function onMachine(machine: string, view: View): View {
  if (view.kind === 'machine') return view;
  return { kind: 'machine', machine, view };
}

/** A conversation on a computer as a page there: its worktree's (`ws:<id>`); none for anything else. */
export function pageOfChannel(channel: string): View | undefined {
  return channel.startsWith('ws:') && channel.length > 3 ? { kind: 'workspace', id: channel.slice(3), tab: 'chat' } : undefined;
}

/** Which computer a window's view is on (none: this Mac) and the page itself. */
export function paneOf(view: View): { readonly machine?: string; readonly view: View } {
  return view.kind === 'machine' ? { machine: view.machine, view: view.view } : { view };
}

/**
 * A memory the window keeps per chat, worktree or project (the words left in a box, Plan with
 * Tasks picked, a panel's tab) for the page's computer: two computers' `ws:…` or `room` never share
 * one, and this Mac's keys stay exactly as they were.
 */
export const scopedKey = (machine: string | undefined, key: string): string => (machine ? `${machine}/${key}` : key);

const tags = new WeakMap<object, string>();
let nextTag = 0;

/**
 * A short tag for whose state a runtime cache read something from (a client, or its api): a file
 * at the same path on two computers is two files. Tags live as long as the window does.
 */
export function sourceTag(source: object): string {
  let tag = tags.get(source);
  if (!tag) tags.set(source, (tag = `c${++nextTag}`));
  return tag;
}

/** The same page with the same details (a tab, a chat). */
export const sameView = (a: View, b: View): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The pane went somewhere on the computer (a link, a tab, the computer's own answer to an open):
 * the window's view that says so, or undefined when the window already does.
 */
export function windowViewFor(machine: string, windowView: View, paneView: View): View | undefined {
  const { machine: shown, view } = paneOf(windowView);
  if (shown === machine && sameView(view, paneView)) return undefined;
  return onMachine(machine, paneView);
}

/**
 * The window went to a page on the computer (Back, a row, a notification): what the pane's own
 * screen should show, or undefined when it already does.
 */
export function paneViewFor(machine: string, windowView: View, paneView: View): View | undefined {
  const { machine: shown, view } = paneOf(windowView);
  if (shown !== machine || sameView(view, paneView)) return undefined;
  return view;
}

/** The app's socket for computer `id`: the daemon's own address with /machine/<id> (BLG-775). */
export function machineSocketUrl(daemonUrl: string, id: string): string {
  if (!isMachineId(id)) throw new Error('That isn’t one of your computers');
  const url = new URL(daemonUrl);
  url.pathname = `/machine/${id}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * What a pane's UI state keeps for the window rather than for itself: the palette, Settings, the
 * bell, the sidebar's own cursor and folds. The rest (the box's words, an open menu, a file full
 * screen) is the pane's, so the window and each computer keep their own while you go between them.
 */
export const WINDOW_UI_KEYS: ReadonlySet<string> = new Set([
  'palette',
  'notices',
  'settings',
  'addProject',
  'searchQuery',
  'peek',
  'ask',
  'collapsed',
  'projectsCursor',
  'peopleCursor',
  'overviewScroll',
  'quitArmed',
]);

/** A patch split into what goes to the window and what stays with the pane. A Settings menu is the window's. */
export function splitUiPatch<T extends object>(patch: T): { readonly window: Partial<T>; readonly pane: Partial<T> } {
  const window: Record<string, unknown> = {};
  const pane: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const settingsMenu = k === 'menu' && (v as { menu?: { kind?: string } } | undefined)?.menu?.kind === 'settings';
    if (WINDOW_UI_KEYS.has(k) || settingsMenu) window[k] = v;
    else pane[k] = v;
  }
  return { window: window as Partial<T>, pane: pane as Partial<T> };
}
