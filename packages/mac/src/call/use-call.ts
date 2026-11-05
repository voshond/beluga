import { useMemo, useSyncExternalStore } from 'react';
import type { CallView } from '@beluga/shared/calls.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { useClock } from '../lib/window-active.js';
import { type CallEngine, type CallLive, callEngine } from './engine.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { openConversation } from '../network/use-net.js';

/** Go to where a call is: the room's chat, or the conversation with friends. */
export function openCall(client: SocketClient, conversation: string): void {
  if (conversation === 'room') client.store.dispatch({ type: 'view', view: { kind: 'room' } });
  else openConversation(client, conversation);
}

/** This window's call engine (BLG-706). */
export function useCallEngine(): CallEngine {
  const { client } = useBeluga();
  return callEngine(client);
}

/** What the call you're in looks like right now: who's talking, the lines, the stage. */
export function useCallLive(): CallLive {
  const engine = useCallEngine();
  return useSyncExternalStore(engine.subscribe, engine.get);
}

/** A conversation's call, as the daemon says (going on, ringing for you, or none). */
export function useConversationCall(conversation: string | undefined): CallView | undefined {
  return useApp((st) => (conversation ? st.network.calls?.[conversation] : undefined));
}

/** The call you're in, if any. */
export function useMyCall(): CallView | undefined {
  return useApp((st) => Object.values(st.network.calls ?? {}).find((c) => c.mine === 'in'));
}

/** Calls ringing for you now, oldest first. */
export function useRinging(): readonly CallView[] {
  const calls = useApp((st) => st.network.calls);
  return useMemo(
    () =>
      Object.values(calls ?? {})
        .filter((c) => c.mine === 'ringing')
        .sort((a, b) => (a.ringSince ?? 0) - (b.ringSince ?? 0)),
    [calls],
  );
}

/** The time now, once a second while you look (a call's length). */
export const useSecond = (): number => useClock(true);

/** A conversation's name for a call: the friend's, or the channel's with its #. */
export function useCallPlace(conversation: string | undefined): string {
  return useApp((st) => {
    if (!conversation) return '';
    if (conversation === 'room') return 'the room';
    if (conversation.startsWith('dm:')) return st.network.friends.find((f) => f.peerId === conversation.slice(3))?.name ?? 'a friend';
    const g = st.network.groups.find((x) => x.id === conversation.slice(6));
    return g ? `#${g.name}` : 'a channel';
  });
}

/**
 * Why nobody in a conversation can be called now (they're all offline), or undefined when someone
 * can: the Call button waits until then, as the daemon would refuse it anyway.
 */
export function useCallUnreachable(conversation: string): string | undefined {
  return useApp((st) => {
    if (conversation === 'room') return st.status === 'connected' && st.peers.some((p) => p.peerId !== st.selfId && !p.guest) ? undefined : 'Nobody else is in the room';
    if (conversation.startsWith('dm:')) {
      const f = st.network.friends.find((x) => x.peerId === conversation.slice(3));
      return f?.online ? undefined : `${f?.name ?? 'They'} can’t be reached right now`;
    }
    const g = st.network.groups.find((x) => x.id === conversation.slice(6));
    return g?.members.some((m) => !m.self && m.online) ? undefined : 'Nobody here can be reached right now';
  });
}

/** Whether the screen shows this conversation now. */
export function useShowing(conversation: string | undefined): boolean {
  return useApp((st) => (conversation === 'room' ? st.view.kind === 'room' : st.view.kind === 'conversation' && st.view.id === conversation));
}
