import { honchoOf, maybeHonchoOf } from '../core/honcho/feed.js';
import { allowedConversation } from '../core/honcho/filter.js';
import type { Session } from '../core/session.js';
import type { HonchoPicture } from '../shared/honcho.js';
import type { Args, Method } from './api.js';

type HonchoMethod = Extract<Method, `honcho.${string}`>;
type HonchoHandlers = { readonly [M in HonchoMethod]: (s: Session, ...args: Args<M>) => unknown };

/** Whether a conversation's messages go to Honcho now: the feed is on, and the same rule as what it sends lets this one through. */
export const honchoSends = (s: Pick<Session, 'store' | 'sharing'>, channel: string, status = maybeHonchoOf(s)?.status()): boolean => {
  if (!status?.enabled) return false;
  return allowedConversation({ state: s.store.getState(), excluded: status.excluded, since: status.since ?? 0, sharedWith: (c) => s.sharing.recipients(c).length > 0 }, channel) !== undefined;
};

export const HONCHO_HANDLERS = {
  'honcho.status': (s) => honchoOf(s).status(),
  'honcho.sends': (s, channel) => honchoSends(s, channel),
  'honcho.configure': (s, patch) => honchoOf(s).configure(patch),
  'honcho.test': (s, draft) => honchoOf(s).test(draft),
  'honcho.picture': (s): Promise<HonchoPicture> => maybeHonchoOf(s)?.pictureView() ?? Promise.resolve({ enabled: false, text: '' }),
} satisfies HonchoHandlers;
