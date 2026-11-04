import type { LogItem } from '@beluga/core/store.js';

/**
 * The earlier conversation of a workspace someone shared with you arrives as system lines
 * ("bob: …"). Here each one that says who wrote it is
 * drawn as that person's (or their Claude's) message: an avatar, a name, the text.
 */
export function asChatRow(item: LogItem): LogItem {
  if (item.type !== 'system' || !item.said) return item;
  const { from, name, text, byAgent, ts } = item.said;
  const row: LogItem = { id: item.id, type: 'chat', channel: item.channel, from, name, text, ts: ts || item.ts, byAgent };
  earlier.add(row);
  return row;
}

const earlier = new WeakSet<LogItem>();

/** A row asChatRow drew from an earlier line: not a message of its own here (nothing to react to, BLG-702). */
export const isEarlierLine = (item: LogItem): boolean => earlier.has(item);
