import { makeReport } from '../core/blackbox/report.js';
import { installedVersion } from '../core/version.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `diagnostics.*` method does (see diagnostics-api.ts). */

type DiagnosticsMethod = Extract<Method, `diagnostics.${string}`>;
type DiagnosticsHandlers = { readonly [M in DiagnosticsMethod]: (s: Session, ...args: Args<M>) => unknown };

export const DIAGNOSTICS_HANDLERS = {
  'diagnostics.report': () => makeReport({ version: installedVersion() }),
} satisfies DiagnosticsHandlers;
