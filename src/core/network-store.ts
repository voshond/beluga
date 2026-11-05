import type { ChatFileState, FriendOfferView, LiveClaude, MessageView, NetworkState, NetworkSummary } from '../net/mesh/views.js';
import type { Reaction } from '../shared/reactions.js';
import type { CallNotesView, CallsView, MissedCallView } from '../shared/calls.js';

/**
 * The Beluga network in the shared state: friends with their status, groups with members,
 * unread counts and last messages, open invitations, and the latest messages per conversation.
 * No keys or secrets ever get here (see net/mesh/views.ts). Browser-safe: the Mac app runs it.
 */

export interface NetworkSlice {
  readonly network: NetworkState;
}

export const NO_NETWORK: NetworkState = { enabled: false, friends: [], groups: [], invitations: [], pendingJoins: [], messages: {} };

export const initialNetwork: NetworkSlice = { network: NO_NETWORK };

/** Messages kept per conversation in the shared state (older ones: the history API). */
export const KEEP_MESSAGES = 200;

export type NetworkAction =
  /** People, groups, presence or invitations changed. */
  | { type: 'net_summary'; summary: NetworkSummary }
  /** A message arrived, was sent, or changed status (same id: replaced). */
  | { type: 'net_message'; message: MessageView }
  /** A message was deleted from a conversation. */
  | { type: 'net_unsent'; conversation: string; id: string }
  /** A conversation was cleared on this Mac. */
  | { type: 'net_cleared'; conversation: string }
  /** A message's reactions changed (BLG-702): its chips now (one older than what's kept changes nothing here). */
  | { type: 'net_reacted'; conversation: string; id: string; reactions: readonly Reaction[] }
  /** The latest messages of these conversations (on start). */
  | { type: 'net_messages'; messages: Readonly<Record<string, readonly MessageView[]>> }
  /** Chat files changed state (`null`: forget it). */
  | { type: 'net_files'; files: Readonly<Record<string, ChatFileState | null>> }
  /** Someone's Claude started (`live`) or stopped (`idle`) answering in a conversation. */
  | { type: 'net_live'; conversation: string; live: LiveClaude; state: 'thinking' | 'idle' }
  /** Your main channel is this group. */
  | { type: 'net_main'; groupId: string | undefined }
  /** A friend request with someone in your room came or went out (`gone`: it's answered or withdrawn). */
  | { type: 'net_offer'; offer: FriendOfferView }
  | { type: 'net_offer_gone'; peerId: string; dir: 'in' | 'out' }
  /** The calls in your conversations now (BLG-706). */
  | { type: 'net_calls'; calls: CallsView }
  /** Every conversation's call notes now (BLG-715). */
  | { type: 'net_call_notes'; notes: Readonly<Record<string, readonly CallNotesView[]>> }
  /** Every conversation's missed calls now. */
  | { type: 'net_missed_calls'; missed: Readonly<Record<string, readonly MissedCallView[]>> }
  /** The network stopped. */
  | { type: 'net_off' };

/** Friend requests kept at once (both ways). */
export const MAX_OFFERS = 40;

/** A Claude that said nothing for this long isn't shown as answering any more. */
export const LIVE_TTL_MS = 3 * 60_000;

/** Answers one person's Claude is shown working on in one conversation, at most. */
const LIVE_PER_PERSON = 4;

function withLive(list: readonly LiveClaude[] | undefined, live: LiveClaude, state: 'thinking' | 'idle'): readonly LiveClaude[] {
  const rest = (list ?? []).filter((l) => !(l.peerId === live.peerId && l.for === live.for) && live.since - l.since < LIVE_TTL_MS);
  if (state !== 'thinking') return rest;
  const theirs = rest.filter((l) => l.peerId === live.peerId);
  const drop = new Set(theirs.slice(0, Math.max(0, theirs.length - LIVE_PER_PERSON + 1)));
  return [...rest.filter((l) => !drop.has(l)), live];
}

function withMessage(list: readonly MessageView[], m: MessageView): readonly MessageView[] {
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) return list.map((x, i) => (i === at ? m : x));
  return [...list, m].slice(-KEEP_MESSAGES);
}

/** A message with these chips (none: the field goes). */
function withReactions(m: MessageView, reactions: readonly Reaction[]): MessageView {
  const { reactions: _was, ...rest } = m;
  return reactions.length ? { ...rest, reactions } : rest;
}

export function reduceNetwork(state: NetworkSlice, action: NetworkAction): NetworkSlice {
  switch (action.type) {
    case 'net_summary': {
      const { files, live, main, calls, callNotes, missedCalls } = state.network;
      // A friend request is over once you're friends (either side may have used it).
      const offers = state.network.offers?.filter((o) => !action.summary.friends.some((f) => f.peerId === o.peerId));
      return { network: { ...action.summary, messages: state.network.messages, ...(files ? { files } : {}), ...(live ? { live } : {}), ...(main ? { main } : {}), ...(offers?.length ? { offers } : {}), ...(calls && Object.keys(calls).length ? { calls } : {}), ...(callNotes ? { callNotes } : {}), ...(missedCalls ? { missedCalls } : {}) } };
    }
    case 'net_offer': {
      const o = action.offer;
      const rest = (state.network.offers ?? []).filter((x) => !(x.peerId === o.peerId && x.dir === o.dir));
      return { network: { ...state.network, offers: [...rest, o].slice(-MAX_OFFERS) } };
    }
    case 'net_offer_gone': {
      const { offers: was, ...rest } = state.network;
      const offers = (was ?? []).filter((x) => !(x.peerId === action.peerId && x.dir === action.dir));
      return { network: offers.length ? { ...rest, offers } : rest };
    }
    case 'net_message': {
      const m = action.message;
      const messages = { ...state.network.messages, [m.conversation]: withMessage(state.network.messages[m.conversation] ?? [], m) };
      // A Claude's answer arrived: it isn't "thinking" any more.
      const was = state.network.live?.[m.conversation];
      const answered = m.claude && was?.some((l) => l.peerId === m.from && l.for === m.claude!.for);
      const live = answered ? { ...state.network.live, [m.conversation]: was!.filter((l) => !(l.peerId === m.from && l.for === m.claude!.for)) } : state.network.live;
      return { network: { ...state.network, messages, ...(live ? { live } : {}) } };
    }
    case 'net_unsent': {
      const list = state.network.messages[action.conversation];
      if (!list?.some((m) => m.id === action.id)) return state;
      return { network: { ...state.network, messages: { ...state.network.messages, [action.conversation]: list.filter((m) => m.id !== action.id) } } };
    }
    case 'net_reacted': {
      const list = state.network.messages[action.conversation];
      if (!list?.some((m) => m.id === action.id)) return state;
      const next = list.map((m) => (m.id === action.id ? withReactions(m, action.reactions) : m));
      return { network: { ...state.network, messages: { ...state.network.messages, [action.conversation]: next } } };
    }
    case 'net_cleared':
      return { network: { ...state.network, messages: { ...state.network.messages, [action.conversation]: [] } } };
    case 'net_files': {
      const files: Record<string, ChatFileState> = { ...state.network.files };
      for (const [sha, f] of Object.entries(action.files)) {
        if (f) files[sha] = f;
        else delete files[sha];
      }
      return { network: { ...state.network, files } };
    }
    case 'net_live':
      return { network: { ...state.network, live: { ...state.network.live, [action.conversation]: withLive(state.network.live?.[action.conversation], action.live, action.state) } } };
    case 'net_main': {
      const { main: _old, ...rest } = state.network;
      return { network: action.groupId ? { ...rest, main: action.groupId } : rest };
    }
    case 'net_calls': {
      const { calls: _was, ...rest } = state.network;
      return { network: Object.keys(action.calls).length ? { ...rest, calls: action.calls } : rest };
    }
    case 'net_call_notes': {
      const { callNotes: _was, ...rest } = state.network;
      return { network: Object.keys(action.notes).length ? { ...rest, callNotes: action.notes } : rest };
    }
    case 'net_missed_calls': {
      const { missedCalls: _was, ...rest } = state.network;
      return { network: Object.keys(action.missed).length ? { ...rest, missedCalls: action.missed } : rest };
    }
    case 'net_messages':
      return { network: { ...state.network, messages: { ...state.network.messages, ...Object.fromEntries(Object.entries(action.messages).map(([k, v]) => [k, v.slice(-KEEP_MESSAGES)])) } } };
    case 'net_off': {
      // Friend requests came through the room: they're still there when the network comes back on.
      // So are the calls you missed (the room's too): they're kept on disk, not by the network.
      const { offers, missedCalls } = state.network;
      return { network: { ...NO_NETWORK, ...(offers?.length ? { offers } : {}), ...(missedCalls ? { missedCalls } : {}) } };
    }
    default:
      return state;
  }
}
