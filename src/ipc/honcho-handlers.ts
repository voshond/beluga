import { honchoOf } from '../core/honcho/feed.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

type HonchoMethod = Extract<Method, `honcho.${string}`>;
type HonchoHandlers = { readonly [M in HonchoMethod]: (s: Session, ...args: Args<M>) => unknown };

export const HONCHO_HANDLERS = {
  'honcho.status': (s) => honchoOf(s).status(),
  'honcho.configure': (s, patch) => honchoOf(s).configure(patch),
  'honcho.test': (s, draft) => honchoOf(s).test(draft),
} satisfies HonchoHandlers;
