import { z } from 'zod';

/**
 * Problem reports (core/blackbox): the black box, the problems it froze and the end of the log,
 * redacted, in one file to attach to an issue. Only the Mac app makes one. Browser-safe: zod only.
 */

export const DIAGNOSTICS_API = {
  // Settings › About › Report a Problem: write a report into ~/.beluga/logs/reports and say where.
  'diagnostics.report': { args: z.tuple([]) },
} as const;
