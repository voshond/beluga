import path from 'node:path';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { readJson, writeJson } from '../net/mesh/files.js';

/**
 * Where you are on the network (BLG-796), as this install keeps it in ~/.beluga/always-on.json:
 * here (this install holds your identity and runs your friends network, as every install did before
 * Always On; also when the file is missing), or on another device of yours, by its id and name.
 * While it's elsewhere this install never starts the friends network itself (core/network.ts): there
 * is only ever one of you online.
 *
 * `pending`: a handover this install gave and whose last step (the other side installing it) it
 * hasn't heard back about yet; it asks again until it does (always-on.ts).
 */

const DeviceRef = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/), name: z.string().min(1).max(64) });

export const AlwaysOnFile = z.object({
  v: z.literal(1),
  at: z.union([z.literal('here'), DeviceRef]),
  since: z.number().int().min(0),
  pending: z.object({ id: z.string().regex(/^[0-9a-f]{16}$/), stage: z.string().regex(/^[0-9a-f]{32}$/) }).optional(),
  /** Here, standing in for your Always On while it's down (BLG-799): handed back when it answers again. */
  standIn: DeviceRef.optional(),
});
export type AlwaysOnFile = z.infer<typeof AlwaysOnFile>;

export type Whereabouts = { readonly here: true; readonly since?: number; readonly standIn?: { id: string; name: string } } | { readonly here: false; readonly id: string; readonly name: string; readonly since: number };

export const alwaysOnFile = (dir: string): string => path.join(dir, 'always-on.json');

export function readAlwaysOn(dir: string): AlwaysOnFile | undefined {
  const parsed = AlwaysOnFile.safeParse(readJson(alwaysOnFile(dir)));
  return parsed.success ? parsed.data : undefined;
}

export function writeAlwaysOn(dir: string, state: AlwaysOnFile): void {
  writeJson(alwaysOnFile(dir), state);
}

export function clearAlwaysOn(dir: string): void {
  rmSync(alwaysOnFile(dir), { force: true });
}

/** Where your network runs, as this install knows. */
export function whereabouts(dir: string): Whereabouts {
  const state = readAlwaysOn(dir);
  if (!state || state.at === 'here') return state ? { here: true, since: state.since, ...(state.standIn ? { standIn: state.standIn } : {}) } : { here: true };
  return { here: false, id: state.at.id, name: state.at.name, since: state.since };
}

/** Why this install mustn't start the friends network itself, or undefined when it may. */
export function networkElsewhere(dir: string): string | undefined {
  const w = whereabouts(dir);
  return w.here ? undefined : `Your friends network runs on ${w.name}, your Always On: this Beluga shows it through your link instead of running it.`;
}
