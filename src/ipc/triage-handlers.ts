import type { Session } from '../core/session.js';
import { needTriage } from '../core/triage/launch.js';
import type { Args, Method } from './api.js';

/** What each `triage.*` method does (see triage-api.ts). */

type TriageMethod = Extract<Method, `triage.${string}`>;
type TriageHandlers = { readonly [M in TriageMethod]: (s: Session, ...args: Args<M>) => unknown };

export const TRIAGE_HANDLERS = {
  'triage.settle': (s, channel) => needTriage(s).settle(channel),
  'triage.unsettle': (s, channel) => needTriage(s).unsettle(channel),
  'triage.snooze': (s, channel, until) => needTriage(s).snooze(channel, until),
  'triage.wake': (s, channel) => needTriage(s).wake(channel),
  'triage.setAutoSettle': (s, channel, on) => needTriage(s).setAutoSettle(channel, on),
} satisfies TriageHandlers;
