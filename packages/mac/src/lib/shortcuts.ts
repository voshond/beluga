import { useEffect, useSyncExternalStore } from 'react';
import { appInvoke, native } from './boot-mode.js';
import { getPrefs, subscribePrefs } from './prefs.js';
import { type Bindings, type KeyPress, bindingsOf, chordOfAccel, keysLabel, menuAccel, menuKeys, pressed } from './shortcuts-model.js';

/**
 * Your keyboard shortcuts in this window (BLG-289): the keys each shortcut has now (Settings ›
 * Keyboard changes them), whether a key press is one, the label a tooltip shows, and the menu bar
 * kept showing the same keys.
 */


let seen: { shortcuts: unknown; voice: string } | undefined;
let cached: Bindings = bindingsOf({});

/** Every shortcut's keys right now. */
export function getBindings(): Bindings {
  const p = getPrefs();
  if (seen?.shortcuts !== p.shortcuts || seen.voice !== p.voiceShortcut) {
    seen = { shortcuts: p.shortcuts, voice: p.voiceShortcut };
    cached = bindingsOf(p.shortcuts, p.voiceShortcut ? (chordOfAccel(p.voiceShortcut) ?? '') : '');
  }
  return cached;
}

export const useBindings = (): Bindings => useSyncExternalStore(subscribePrefs, getBindings);

/** This key press is that shortcut. */
export const isShortcut = (id: string, e: KeyPress): boolean => !recording && pressed(getBindings(), id, e);

/** A shortcut's key as a tooltip shows it (⇧⌘C), or undefined when it has none. */
export const shortcutKeys = (id: string): string | undefined => keysLabel(getBindings(), id);

/** The same, redrawn when you change your keys. */
export function useShortcutKeys(): (id: string) => string | undefined {
  const b = useBindings();
  return (id) => keysLabel(b, id);
}

/* ---------- Recording ---------- */

let recording = false;

/** While Settings records a shortcut, no shortcut runs (and the menu bar's keys are off). */
export function setRecording(on: boolean): void {
  if (recording === on) return;
  recording = on;
  sendMenuKeys();
}
export const isRecording = (): boolean => recording;

/* ---------- Once, from the window or the menu bar ---------- */

// A key press can reach both the window and the menu bar (its item has the same key), in either
// order: it runs once. Whichever comes second within a moment is the echo.
const ran = new Map<string, { readonly by: 'key' | 'menu'; readonly at: number }>();
const ECHO_MS = 300;

function once(by: 'key' | 'menu', id: string, run: () => void): void {
  const last = ran.get(id);
  const now = Date.now();
  if (last && last.by !== by && now - last.at < ECHO_MS) return;
  ran.set(id, { by, at: now });
  run();
}
export const fromKey = (id: string, run: () => void): void => once('key', id, run);
export const fromMenu = (id: string, run: () => void): void => (recording ? undefined : once('menu', id, run));

/* ---------- The terminal's keys (BLG-537) ---------- */

/** Keys the terminal view has the keyboard for now (its ⌘T, ⌘W, ⌘1…): the menu bar lets go of them. */
let terminalChords: ReadonlySet<string> = new Set();

/** The terminal view took the keyboard with these keys (none: it let go). */
export function setTerminalChords(chords: readonly string[] | undefined): void {
  const next = new Set(chords ?? []);
  if (next.size === terminalChords.size && [...next].every((c) => terminalChords.has(c))) return;
  terminalChords = next;
  sendMenuKeys();
}

/** Whether Beluga has a shortcut on this chord (so the terminal leaves it, when Beluga's keys come first). */
export const belugaHas = (chord: string): boolean => Object.values(getBindings()).some((list) => list.includes(chord)) || chord === 'Cmd+W';

/* ---------- The menu bar ---------- */

let sentMenu = '';

function sendMenuKeys(): void {
  if (!native('menuKeys')) return;
  // Close Window is the menu's own item (menu.rs), with ⌘W unless the terminal has it.
  const keys: Record<string, string | null> = { ...menuKeys(getBindings()), 'close-window': 'CmdOrCtrl+W' };
  const taken = new Set([...terminalChords].map(menuAccel).filter(Boolean));
  for (const [id, accel] of Object.entries(keys)) if (accel && taken.has(accel)) keys[id] = null;
  // Recording: every item lets go of its key, so pressing ⌘R to record it doesn't run Run.
  const out = recording ? Object.fromEntries(Object.keys(keys).map((k) => [k, null])) : keys;
  const json = JSON.stringify(out);
  if (json === sentMenu) return;
  sentMenu = json;
  void appInvoke('set_menu_keys', { keys: out }).catch(() => (sentMenu = ''));
}

/** Mounted once (App): the menu bar shows your keys, and follows when you change them. */
export function useMenuKeys(): void {
  useEffect(() => {
    sendMenuKeys();
    return subscribePrefs(sendMenuKeys);
  }, []);
}
