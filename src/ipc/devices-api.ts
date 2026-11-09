import { z } from 'zod';

/**
 * Client devices: the remote apps connected to this server that offer their machine to the agents
 * (core/devices). Browser-safe: zod only.
 */

export const DEVICES_API = {
  // The devices connected now: name, OS, what they allow, last seen.
  'devices.list': { args: z.tuple([]) },
} as const;
