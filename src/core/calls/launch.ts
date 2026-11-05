import path from 'node:path';
import { currentClient } from '../client-context.js';
import { belugaHome } from '../home.js';
import { watchNetwork } from '../network.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { type CallView, type CallsView, type MissedCallView, missedCallText } from '../../shared/calls.js';
import { MissedCalls } from './missed.js';
import { CallNotes } from './notes.js';
import { type NotesSource, callNotesTools, notesHint } from './notes-tools.js';
import type { CallNotesTools } from '../../agent/types.js';
import { ROOM_CONVERSATION, roomLinks } from './room.js';
import { type CallLinks, CallService, meshLinks } from './service.js';

/**
 * Calls for the daemon (core/calls/service.ts): in your room's chat always (through its hub,
 * BLG-716), and in your conversations with friends while the network is on. What they are goes
 * into the shared state (`network.calls`), their setup to the window in each call as a
 * `call_signal` intent, someone ringing you is a notification (the phone shows it in Needs you),
 * and their notes are kept in one place (`network.callNotes`, BLG-715).
 */

interface Calls {
  readonly room: CallService;
  readonly roomInbox: (from: string, payload: unknown) => void;
  friends?: CallService;
  readonly notes: CallNotes;
}

const sessions = new WeakMap<object, Calls>();

/** This session's call notes (BLG-715). */
export const callNotesOf = (session: object): CallNotes | undefined => sessions.get(session)?.notes;

/** Where a conversation is, in words an agent reads. */
function placeOf(store: Store, conversation: string): string {
  const st = store.getState();
  if (conversation === ROOM_CONVERSATION) return 'the room';
  if (conversation.startsWith('dm:')) return `a DM with ${st.network.friends.find((f) => f.peerId === conversation.slice(3))?.name ?? 'a friend'}`;
  return `#${st.network.groups.find((g) => g.id === conversation.slice(6))?.name ?? 'a channel'}`;
}

const sources = new WeakMap<object, NotesSource>();

/** Every call's notes as tools, for your own runs (BLG-715). */
export function callNotesToolsOf(session: object): CallNotesTools | undefined {
  const src = sources.get(session);
  return src ? callNotesTools(src) : undefined;
}

/** One conversation's calls as tools, and what an agent asked there is told about them; undefined when it has none. */
export function chatNotesOf(session: object, conversation: string): { readonly hint: string; readonly tools: CallNotesTools } | undefined {
  const src = sources.get(session);
  const hint = src && notesHint(src, conversation);
  return src && hint ? { hint, tools: callNotesTools(src, conversation) } : undefined;
}

/** A call frame that came through the room (session.ts hands it over). */
export function receiveRoomCall(session: object, from: string, payload: unknown): void {
  sessions.get(session)?.roomInbox(from, payload);
}

/** The calls of a conversation: the room's, or your friends' (a clear error while the network is off). */
export function callsFor(session: object, conversation: string): CallService {
  const calls = sessions.get(session);
  if (!calls) throw new Error('Calls aren’t running here');
  if (conversation === ROOM_CONVERSATION) return calls.room;
  if (!calls.friends) throw new Error('Calls with friends need the Beluga network: turn it on in Settings › Network');
  return calls.friends;
}

/** The call service that remembers a past call (for its notes). */
export function callsWithPast(session: object, id: string): CallService | undefined {
  const calls = sessions.get(session);
  return [calls?.room, calls?.friends].find((s) => s?.pastCall(id));
}

/** Every call now, the room's and your friends'. */
export function allCalls(session: object): CallsView {
  const calls = sessions.get(session);
  return { ...calls?.friends?.list(), ...calls?.room.list() };
}

export interface CallsHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

/** Where a call rang, in a notification's words ("in #design"); none for a DM. */
function ringPlace(store: Store, conversation: string): string | undefined {
  if (conversation === ROOM_CONVERSATION) return 'in the room';
  const group = conversation.startsWith('group:') ? store.getState().network.groups.find((g) => g.id === conversation.slice(6)) : undefined;
  return group ? `in #${group.name}` : undefined;
}

/** Where a ring's notification opens, and what it says. */
function ringNotice(store: Store, call: CallView): { title: string; body: string } {
  const st = store.getState();
  const named = (id: string | undefined): string | undefined => (id ? (st.network.friends.find((f) => f.peerId === id)?.name ?? st.peers.find((p) => p.peerId === id)?.name ?? call.people.find((p) => p.peerId === id)?.name) : undefined);
  const by = named(call.ringBy) ?? 'Someone';
  return { title: `${by} is calling`, body: ringPlace(store, call.conversation) ?? 'Answer in Beluga' };
}

export function launchCalls(host: CallsHost): () => void {
  const { session, store } = host;
  let friendLinks: CallLinks | undefined;
  const parts: { room: CallsView; friends: CallsView } = { room: {}, friends: {} };
  const publish = (): void => {
    const view = { ...parts.friends, ...parts.room };
    store.dispatch({ type: 'net_calls', calls: host.demo ? Object.fromEntries(Object.entries(view).map(([k, c]) => [k, { ...c, demo: true as const }])) : view });
  };
  const missed = new MissedCalls({
    file: host.demo ? null : path.join(belugaHome(), 'missed-calls.json'),
    publish: (view) => store.dispatch({ type: 'net_missed_calls', missed: view }),
  });
  store.dispatch({ type: 'net_missed_calls', missed: missed.views() });
  const common = {
    signal: (to: string | undefined, s: { conversation: string; call: string; from: string; data: string }) => session.intents.emit({ type: 'call_signal', ...s }, to),
    ring: (call: CallView, on: boolean) => {
      if (!on) return;
      const { title, body } = ringNotice(store, call);
      session.notifier.notify({ kind: 'people', tag: 'message', title, body, channel: call.conversation, need: `call:${call.id}`, watched: true });
    },
    toast: (text: string) => session.intents.emit({ type: 'toast', text, level: 'info' }, undefined),
    client: currentClient,
    // It stopped ringing before you answered: kept in its conversation, and in the inbox for when you're back.
    missed: (call: MissedCallView) => {
      missed.add(call);
      session.notifier.notify({ kind: 'people', tag: 'message', title: missedCallText(call), body: ringPlace(store, call.conversation) ?? 'Call back from your chat', channel: call.conversation, key: `missed:${call.id}` });
    },
  };
  const notes = new CallNotes({
    dir: host.demo ? null : path.join(belugaHome(), 'call-notes'),
    isMe: (id) => id === store.getState().selfId || id === friendLinks?.peerId,
    nameOf: (id) => store.getState().peers.find((p) => p.peerId === id)?.name ?? friendLinks?.nameFor(id) ?? 'someone',
    publish: (view) => store.dispatch({ type: 'net_call_notes', notes: view }),
  });
  store.dispatch({ type: 'net_call_notes', notes: notes.views() });
  sources.set(session, { views: () => notes.views(), placeOf: (c) => placeOf(store, c) });
  const room = roomLinks({ store, send: (to, p) => session.send({ kind: 'call', p }, { to }) });
  const roomCalls = new CallService({
    ...common,
    links: room.links,
    publish: (view) => {
      parts.room = view;
      publish();
    },
    notes: (from, call, phrases) => notes.theirs(from, call, phrases),
  });
  const calls: Calls = { room: roomCalls, roomInbox: room.receive, notes };
  sessions.set(session, calls);
  const off = watchNetwork(session, (service) => {
    calls.friends?.stop();
    calls.friends = undefined;
    friendLinks = undefined;
    parts.friends = {};
    publish();
    if (!service) return;
    friendLinks = meshLinks(service.mesh);
    calls.friends = new CallService({
      ...common,
      links: friendLinks,
      publish: (view) => {
        parts.friends = view;
        publish();
      },
      notes: (from, call, phrases) => notes.theirs(from, call, phrases),
    });
  });
  return () => {
    off();
    calls.friends?.stop();
    roomCalls.stop();
    room.stop();
    sessions.delete(session);
    sources.delete(session);
  };
}
