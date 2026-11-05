import { allCalls, callNotesOf, callsFor, callsWithPast } from '../core/calls/launch.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `calls.*` method does (see calls-api.ts): the room's calls or your friends', by conversation. */

type CallsMethod = Extract<Method, `calls.${string}`>;
type CallsHandlers = { readonly [M in CallsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const CALLS_HANDLERS = {
  'calls.start': (s, conversation) => callsFor(s, conversation).start(conversation),
  'calls.join': (s, conversation) => callsFor(s, conversation).join(conversation),
  'calls.leave': (s, conversation) => callsFor(s, conversation).leave(conversation),
  'calls.decline': (s, conversation) => callsFor(s, conversation).decline(conversation),
  'calls.set': (s, conversation, change) => callsFor(s, conversation).set(conversation, change),
  'calls.signal': (s, conversation, to, data) => callsFor(s, conversation).signal(conversation, to, data),
  'calls.notes': (s, id, phrases) => {
    const calls = callsWithPast(s, id);
    const call = calls?.pastCall(id);
    if (!calls || !call) throw new Error('That call isn’t one you were in');
    // Nobody else ever joined: the call never started, so it has no notes.
    if (![...call.people].some((p) => p !== calls.selfId)) return 0;
    callNotesOf(s)?.mine(calls.selfId, call, phrases);
    return calls.sendNotes(id, phrases);
  },
  'calls.forgetNotes': (s, id) => callNotesOf(s)?.forget(id),
  'calls.list': (s) => allCalls(s),
} satisfies CallsHandlers;
