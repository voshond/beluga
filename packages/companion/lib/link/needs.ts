import type { NeedsYou } from './protocol';

/**
 * Needs You across your Mac and your computers (BLG-810, BLG-857). A computer's item is listed
 * under `<computer id>|<its id>`, so the id itself says where its answer goes; your Mac's ids
 * never hold a `|`. Pure: lib/store.ts and lib/hooks.ts use it, tests/companion-friends-nudges.test.ts
 * runs it.
 */

/** A computer's items, under ids that route back to it, each saying which computer. */
export function placeNeeds(on: string, name: string | undefined, items: readonly NeedsYou[] | undefined): NeedsYou[] {
  return (items ?? []).map((n) => ({ ...n, id: `${on}|${n.id}`, from: [name, n.from].filter(Boolean).join(' · ').slice(0, 200) }));
}

/** Which computer an item is from, and its own id there; none: your Mac's. */
export function needRoute(id: string): { readonly on: string; readonly id: string } | undefined {
  const m = /^([0-9a-f]{16})\|(.+)$/.exec(id);
  return m ? { on: m[1]!, id: m[2]! } : undefined;
}

/**
 * Your Mac's items and every computer's, each thing once. Your Always On's friends' requests are
 * also on your Mac while it shows that network: with the Mac's link open its copy is kept (as
 * before); with it closed, the computer's, so the answer goes where it can be taken now instead of
 * waiting for the Mac (BLG-857).
 */
export function mergeNeeds(mac: readonly NeedsYou[] | undefined, theirs: readonly NeedsYou[], macOpen: boolean): NeedsYou[] {
  const mine = mac ?? [];
  if (!theirs.length) return [...mine];
  if (macOpen) {
    const macIds = new Set(mine.map((n) => n.id));
    return [...mine, ...theirs.filter((n) => !macIds.has(needRoute(n.id)?.id ?? n.id))];
  }
  const theirIds = new Set(theirs.map((n) => needRoute(n.id)?.id ?? n.id));
  return [...mine.filter((n) => !theirIds.has(n.id)), ...theirs];
}
