import path from 'node:path';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { readJson, writeJson } from '../net/mesh/files.js';
import type { Settings } from '../shared/settings-schema.js';
import { CARRIED_SETTINGS, CarriedSettings } from './always-on-bundle.js';

/**
 * The settings that are you to friends while this Mac stands in for your Always On (BLG-848).
 *
 * Standing in, this Mac runs on the Always On's newest: the carried settings of the replica it stands
 * in with (trust levels, Ask Me For, what friends may ask, policy) are applied here, and kept as the
 * baseline (standin-settings.json). Handing back, only what changed since then travels, each with
 * when it changed: a whole setting, or one person's trust level. The Always On keeps its own value
 * for everything else, so a change it made that this Mac never saw is never overwritten.
 *
 * These settings belong to your identity and never ride the device sync (sync.ts LOCAL_SETTINGS), so
 * there are no sync versions to merge with: the stand-in's own changes are always the newer, since the
 * Always On was down while they were made.
 */

const FILE = 'standin-settings.json';
const Baseline = z.object({ at: z.number().int().min(0), settings: CarriedSettings });
type Baseline = z.infer<typeof Baseline>;

type CarriedKey = (typeof CARRIED_SETTINGS)[number];
type Person = NonNullable<Settings['people']>[string];

/** What changed during a stand-in: whole settings (null: unset), and people one by one (null: forgotten). */
export const StandInChanges = z.object({
  at: z.number().int().min(0),
  settings: z.record(z.string(), z.unknown()).default({}),
  people: z.record(z.string(), z.object({ name: z.string().max(32), trust: z.string().max(20) }).nullable()).default({}),
});
export type StandInChanges = z.infer<typeof StandInChanges>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The carried settings as a patch for settings.json: every carried key, unset ones cleared (your name stays when it has none). */
function asPatch(carried: CarriedSettings): Partial<Settings> {
  return Object.fromEntries(CARRIED_SETTINGS.filter((k) => k !== 'name' || carried.name !== undefined).map((k) => [k, carried[k]])) as Partial<Settings>;
}

/** Standing in: the replica's settings become this Mac's, and the baseline the hand-back compares with. */
export function beginStandIn(dir: string, replica: CarriedSettings, save: (patch: Partial<Settings>) => void, now: number): void {
  save(asPatch(replica));
  writeJson(path.join(dir, FILE), { at: now, settings: replica } satisfies Baseline);
}

export function readBaseline(dir: string): Baseline | undefined {
  const parsed = Baseline.safeParse(readJson(path.join(dir, FILE)));
  return parsed.success ? parsed.data : undefined;
}

export function endStandIn(dir: string): void {
  rmSync(path.join(dir, FILE), { force: true });
}

/** What changed here since the stand-in began (none without a baseline: nothing is sent over the Always On's own). */
export function changesSince(dir: string, now: CarriedSettings, at: number): StandInChanges {
  const base = readBaseline(dir);
  if (!base) return { at, settings: {}, people: {} };
  const settings: Record<string, unknown> = {};
  for (const k of CARRIED_SETTINGS) {
    if (k === 'people') continue;
    if (!same(base.settings[k], now[k])) settings[k] = now[k] ?? null;
  }
  const before = base.settings.people ?? {};
  const after = now.people ?? {};
  const people: Record<string, Person | null> = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) if (!same(before[id], after[id])) people[id] = after[id] ?? null;
  return { at, settings, people };
}

/** The Always On takes a stand-in's changes over its own settings, key by key and person by person; the rest stays its own. */
export function applyChanges(mine: Partial<Settings>, changes: StandInChanges): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes.settings)) {
    if (!(CARRIED_SETTINGS as readonly string[]).includes(k) || k === 'people') continue;
    // Each checked like any other setting: one that doesn't read is left as the Always On has it.
    const checked = CarriedSettings.shape[k as Exclude<CarriedKey, 'people'>].safeParse(v ?? undefined);
    if (checked.success) patch[k] = checked.data;
  }
  if (Object.keys(changes.people).length) {
    const people: Record<string, Person> = { ...(mine.people ?? {}) };
    for (const [id, entry] of Object.entries(changes.people)) {
      if (entry === null) delete people[id];
      else {
        const one = CarriedSettings.shape.people.safeParse({ [id]: entry });
        if (one.success && one.data?.[id]) people[id] = one.data[id];
      }
    }
    patch.people = people;
  }
  return patch as Partial<Settings>;
}
