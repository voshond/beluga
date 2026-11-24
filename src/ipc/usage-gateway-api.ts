import { z } from 'zod';
import { USAGE_SOURCES } from '../shared/usage-gateway.js';

const url = z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Use an http or https address');
const key = z.string().trim().min(1).max(4096);

export const USAGE_GATEWAY_API = {
  'usageGateway.status': { args: z.tuple([]) },
  'usageGateway.configure': {
    args: z.tuple([
      z
        .object({
          source: z.enum(USAGE_SOURCES).optional(),
          url: url.optional(),
          key: key.nullable().optional(),
        })
        .strict(),
    ]),
  },
  'usageGateway.check': { args: z.tuple([z.object({ url: url.optional(), key: key.optional() }).strict().optional()]) },
} as const;
