import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { CallView } from '@beluga/shared/calls.js';
import { inApp } from '../lib/boot.js';
import { openCall } from './use-call.js';
import type { CallEngine } from './engine.js';
import { type FloatAction, type FloatState, floatState } from './float-model.js';

/**
 * The floating call card (BLG-706, src-tauri/src/call_float.rs): while Beluga isn't the window
 * you're in, the call you're in (or one ringing for you) floats above other apps, small, with
 * mute and leave (or join and decline). Come back to Beluga and it goes: the call is in its chat.
 * The window decides what it shows; the card only draws it and hands its buttons back.
 */

let focused = typeof document === 'undefined' ? true : document.hasFocus();
let latest: FloatState | null = null;
let wired = false;
let engineOf: CallEngine | undefined;
/** You hid the card while sharing: only the frame around your screen shows until that share ends (its track). */
let hiddenFor: string | undefined;

/** What the card shows now: nothing while Beluga is in front, or while you hid it for this share. */
function shown(): FloatState | null {
  if (focused) return null;
  const track = engineOf?.sharedTrack()?.id;
  if (latest?.kind === 'in' && latest.youShare && track && track === hiddenFor) return null;
  return latest;
}

async function send(): Promise<void> {
  if (!inApp()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_call_float', { state: shown() }).catch(() => undefined);
}

/** Hear the card's buttons, and Beluga coming forward or going behind (once per window). */
async function wire(client: SocketClient, engine: CallEngine): Promise<void> {
  if (wired || !inApp()) return;
  wired = true;
  engineOf = engine;
  window.addEventListener('focus', () => {
    focused = true;
    void send();
  });
  window.addEventListener('blur', () => {
    focused = false;
    void send();
  });
  const { listen } = await import('@tauri-apps/api/event');
  await listen<{ action: FloatAction; conversation: string }>('call-float-action', ({ payload }) => {
    const { action, conversation } = payload;
    if (action === 'mute' || action === 'unmute') void engine.mute(action === 'mute');
    if (action === 'leave') void engine.leave();
    if (action === 'stop-sharing') void engine.stopSharing();
    if (action === 'hide') {
      hiddenFor = engine.sharedTrack()?.id;
      void send();
    }
    if (action === 'decline') void client.api.calls.decline(conversation).catch(() => undefined);
    if (action === 'join') void engine.join(conversation).catch(() => undefined);
    if (action === 'join' || action === 'open') openCall(client, conversation);
  });
}

/** Keep the card in step with the call (the call layer calls this as anything changes). */
export function syncFloat(client: SocketClient, engine: CallEngine, mine: CallView | undefined, ringing: readonly CallView[], speaking: ReadonlySet<string>): void {
  void wire(client, engine);
  const st = client.store.getState();
  const nameOf = (c: string): string => (c === 'room' ? 'The room' : c.startsWith('dm:') ? (st.network.friends.find((f) => f.peerId === c.slice(3))?.name ?? 'a friend') : `#${st.network.groups.find((g) => g.id === c.slice(6))?.name ?? 'channel'}`);
  latest = floatState(mine, ringing, speaking, nameOf);
  void send();
}
