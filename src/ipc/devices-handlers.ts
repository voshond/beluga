import { devicesOf } from '../core/devices/index.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `devices.*` method does (see devices-api.ts). */

type DevicesMethod = Extract<Method, `devices.${string}`>;
type DevicesHandlers = { readonly [M in DevicesMethod]: (s: Session, ...args: Args<M>) => unknown };

export const DEVICES_HANDLERS = {
  'devices.list': (s) => devicesOf(s)?.list() ?? [],
} satisfies DevicesHandlers;
