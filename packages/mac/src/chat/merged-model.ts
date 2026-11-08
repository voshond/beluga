// Relative paths (not @beluga/…) so the unit tests at the repo root can load this model too.
import type { LogItem, MergedMark, ShippedMark } from '../../../../src/core/store.js';

/** The chat's merge lines: a merge as it happened, and Continue After Merge's divider (see ShippedDivider.tsx). */
export type ShippedItem = Extract<LogItem, { type: 'system' }> & { readonly shipped: ShippedMark };

export const isShippedItem = (l: LogItem): l is ShippedItem => l.type === 'system' && Boolean((l as { shipped?: ShippedMark }).shipped);

export type MergedItem = Extract<LogItem, { type: 'system' }> & { readonly merged: MergedMark };

export const isMergedItem = (l: LogItem): l is MergedItem => l.type === 'system' && Boolean((l as { merged?: MergedMark }).merged);

/**
 * A conversation's items without a merged line that Continue After Merge's divider for the same PR
 * follows straight away: that one says the same and more, so one line is drawn, not two.
 */
export function withoutDoubleMerge<T extends LogItem>(items: readonly T[]): readonly T[] {
  const doubled = items.filter((l, i) => {
    const next: LogItem | undefined = items[i + 1];
    return isMergedItem(l) && l.merged.number !== undefined && next !== undefined && isShippedItem(next) && next.shipped.number === l.merged.number;
  });
  return doubled.length ? items.filter((l) => !doubled.includes(l)) : items;
}
