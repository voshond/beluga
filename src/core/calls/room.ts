import type { Store } from '../store.js';
import type { CallLinks } from './service.js';

/** A room's own conversation: its group chat. */
export const ROOM_CONVERSATION = 'room';

/**
 * Calls in a room (BLG-716): the same calls as with friends, their frames sent to one person at a
 * time through the room's hub (end-to-end encrypted like every room message, never kept for
 * latecomers), and the media still straight between the Macs. Everyone connected to the room, not
 * a guest, is in its conversation.
 */
export function roomLinks(opts: { readonly store: Store; readonly send: (to: string, payload: unknown) => boolean }): { readonly links: CallLinks; receive(from: string, payload: unknown): void; stop(): void } {
  const { store } = opts;
  const callListeners = new Set<(from: string, payload: unknown) => void>();
  const changeListeners = new Set<() => void>();
  const present = (): string[] => {
    const st = store.getState();
    if (st.status !== 'connected') return [];
    return st.peers.filter((p) => p.peerId !== st.selfId && !p.guest).map((p) => p.peerId);
  };
  let peers = store.getState().peers;
  let status = store.getState().status;
  const off = store.subscribe(() => {
    const st = store.getState();
    if (st.peers === peers && st.status === status) return;
    peers = st.peers;
    status = st.status;
    for (const fn of [...changeListeners]) fn();
  });
  const links: CallLinks = {
    get peerId() {
      return store.getState().selfId;
    },
    conversations: () => (store.getState().status === 'connected' ? [ROOM_CONVERSATION] : []),
    shares: (c, p) => c === ROOM_CONVERSATION && present().includes(p),
    peopleIn: (c) => (c === ROOM_CONVERSATION ? present() : []),
    nameFor: (p) => store.getState().peers.find((x) => x.peerId === p)?.name ?? 'someone',
    sendCall: (p, payload) => present().includes(p) && opts.send(p, payload),
    conversationOf: () => ROOM_CONVERSATION,
    groupOf: () => undefined,
    onCall: (fn) => {
      callListeners.add(fn);
      return () => void callListeners.delete(fn);
    },
    onChange: (fn) => {
      changeListeners.add(fn);
      return () => void changeListeners.delete(fn);
    },
  };
  return {
    links,
    receive: (from, payload) => {
      for (const fn of [...callListeners]) fn(from, payload);
    },
    stop: off,
  };
}
