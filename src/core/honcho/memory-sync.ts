import path from 'node:path';
import { z } from 'zod';
import { readJson } from '../../net/mesh/files.js';
import type { MemoryEntry } from '../../shared/memory.js';
import { writeJson } from '../../workspaces/store.js';
import { belugaHome } from '../home.js';
import type { HonchoClient } from './client.js';
import { HONCHO_USER_PEER } from './mapping.js';

/**
 * Beluga's memory about you, written to Honcho as what you said about yourself (BLG-124): each entry
 * becomes one conclusion the user peer holds about itself, so Honcho reasons from what you approved
 * and its dreams can overrule what it guessed. A changed entry replaces its conclusion; a removed one
 * forgets it. Which conclusion is whose lives in ~/.beluga/honcho-memory.json (0600), for the server
 * and workspace it was written to.
 */

export const CONFIRMED = 'Confirmed by the user in Beluga’s memory: ';

export const honchoMemoryPath = (): string => path.join(belugaHome(), 'honcho-memory.json');

const Synced = z.object({
  url: z.string(),
  workspace: z.string(),
  entries: z.record(z.string(), z.object({ text: z.string(), conclusion: z.string() })),
});
export type SyncedMemory = z.infer<typeof Synced>;

export const loadSyncedMemory = (file: string, target: { readonly url: string; readonly workspace: string }): SyncedMemory => {
  const parsed = Synced.safeParse(readJson(file));
  return parsed.success && parsed.data.url === target.url && parsed.data.workspace === target.workspace ? parsed.data : { ...target, entries: {} };
};

export const saveSyncedMemory = (file: string, synced: SyncedMemory): void => writeJson(file, synced);

/** The entries as Honcho should hold them: new and changed ones written, changed and removed ones forgotten. */
export const syncMemory = async (client: Pick<HonchoClient, 'addConclusions' | 'forgetConclusion'>, entries: readonly MemoryEntry[], synced: SyncedMemory): Promise<SyncedMemory> => {
  const kept: SyncedMemory['entries'] = {};
  const fresh: MemoryEntry[] = [];
  const stale: string[] = [];
  for (const entry of entries) {
    const was = synced.entries[entry.id];
    if (was?.text === entry.text) kept[entry.id] = was;
    else {
      if (was) stale.push(was.conclusion);
      fresh.push(entry);
    }
  }
  for (const [id, was] of Object.entries(synced.entries)) if (!entries.some((e) => e.id === id)) stale.push(was.conclusion);
  const ids = fresh.length ? await client.addConclusions(HONCHO_USER_PEER, fresh.map((e) => `${CONFIRMED}${e.text}`)) : [];
  fresh.forEach((entry, i) => {
    if (ids[i]) kept[entry.id] = { text: entry.text, conclusion: ids[i] };
  });
  for (const id of stale) await client.forgetConclusion(id).catch(() => undefined);
  return { ...synced, entries: kept };
};

/** The ids of the conclusions Beluga wrote, so they are never offered back as something Honcho noticed. */
export const syncedIds = (synced: SyncedMemory): Set<string> => new Set(Object.values(synced.entries).map((e) => e.conclusion));
