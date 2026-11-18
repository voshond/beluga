import { z } from 'zod';
import { HONCHO_ID_RE } from '../shared/honcho.js';

const url = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Use an http or https address');
const apiKey = z.string().trim().min(1).max(4096);

export const HONCHO_API = {
  'honcho.status': { args: z.tuple([]) },
  // BLG-102: whether this conversation's messages go to Honcho (it's on and the conversation isn't left out) → boolean.
  'honcho.sends': { args: z.tuple([z.string().min(1).max(4096)]) },
  'honcho.configure': {
    args: z.tuple([
      z
        .object({
          enabled: z.boolean().optional(),
          url: url.optional(),
          apiKey: apiKey.nullable().optional(),
          workspace: z.string().regex(HONCHO_ID_RE).optional(),
          excluded: z.array(z.string().min(1).max(200)).max(500).optional(),
        })
        .strict(),
    ]),
  },
  'honcho.test': { args: z.tuple([z.object({ url: url.optional(), apiKey: apiKey.optional() }).strict().optional()]) },
} as const;
