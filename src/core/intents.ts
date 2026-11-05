import type { Overlay, Toast, View } from './store.js';

/**
 * What the core asks a screen to do: go somewhere, open a dialog, say something briefly, or
 * close a workspace's tab. Screens are the clients' own business (each one has its own), so
 * the core never changes them directly; it sends intents, to the client whose request caused
 * them when there is one, else to every client.
 */
export type Intent =
  /** `unless`: leave the screen alone when it already shows this kind of view. */
  /** `req`: the request id a screen sent with its own open (workspaces.open), echoed so it knows its answer. */
  | { readonly type: 'navigate'; readonly view: View; readonly unless?: View['kind']; readonly req?: string }
  | { readonly type: 'overlay'; readonly overlay: Overlay }
  | { readonly type: 'toast'; readonly text: string; readonly level: Toast['level'] }
  /** A workspace (yours, or one shared with you) is gone: close its tab, and leave it if it's showing. */
  | { readonly type: 'close_tab'; readonly id: string }
  /** WebRTC setup for the window in a call (BLG-706, core/calls): from `from`'s window, for this Mac's. */
  | { readonly type: 'call_signal'; readonly conversation: string; readonly call: string; readonly from: string; readonly data: string }
  /** You asked to leave (/quit): the client closes. */
  | { readonly type: 'quit' };

/** `target`: the client whose request caused it (undefined: every client). */
export type IntentListener = (intent: Intent, target: string | undefined) => void;

/** Delivers intents to whoever shows them (the daemon's connected clients). */
export class IntentBus {
  private readonly listeners = new Set<IntentListener>();

  emit = (intent: Intent, target: string | undefined): void => {
    for (const l of [...this.listeners]) l(intent, target);
  };

  subscribe = (listener: IntentListener): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}
