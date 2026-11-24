import { usageGatewayOf } from '../core/usage-gateway/poller.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

type UsageGatewayMethod = Extract<Method, `usageGateway.${string}`>;
type UsageGatewayHandlers = { readonly [M in UsageGatewayMethod]: (s: Session, ...args: Args<M>) => unknown };

export const USAGE_GATEWAY_HANDLERS = {
  'usageGateway.status': (s) => usageGatewayOf(s).status(),
  'usageGateway.configure': (s, patch) => usageGatewayOf(s).configure(patch),
  'usageGateway.check': (s, draft) => usageGatewayOf(s).check(draft),
} satisfies UsageGatewayHandlers;
