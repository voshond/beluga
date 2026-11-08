import { z } from 'zod';

/** Each chat's category for you (see api.ts, core/triage). Browser-safe: zod only. */

const channel = z.string().min(1).max(200);

export const TRIAGE_API = {
  // Refused while the chat's turn runs, unless it's snoozed.
  'triage.settle': { args: z.tuple([channel]) },
  'triage.unsettle': { args: z.tuple([channel]) },
  // Until when (ms); a time in the past is refused.
  'triage.snooze': { args: z.tuple([channel, z.number().int().positive()]) },
  'triage.wake': { args: z.tuple([channel]) },
  'triage.setAutoSettle': { args: z.tuple([channel, z.boolean()]) },
} as const;
