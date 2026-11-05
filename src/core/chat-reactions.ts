import { type Reaction, type ReactionEvent, applyReaction, reactionsOf } from '../shared/reactions.js';
import type { LogItem } from './store.js';

/**
 * Reactions on the room's and workspaces' chat messages (BLG-702): each `chat` item keeps its
 * changes (`reacts`, folded as shared/reactions.ts says), so they're saved with the conversation's
 * history (~/.beluga/history/<channel>.json) and come back with it. Browser-safe: the store runs it.
 */

/** One person's change to an emoji on chat message `id` in `channel`. */
export interface ChatReactAction {
  readonly type: 'chat_react';
  readonly channel: string;
  readonly id: string;
  readonly emoji: string;
  readonly by: string;
  readonly on: boolean;
  readonly at: number;
}

type ChatItem = Extract<LogItem, { type: 'chat' }>;

/**
 * Where the Mac and the phone offer reactions: the room's group chat, between people. A workspace
 * chat is a conversation with Claude, where an emoji says nothing to anyone (BLG-742).
 */
export const reactableChannel = (channel: string): boolean => channel === 'room';

/** The chips a chat item shows (none: an empty list). */
export const chatReactions = (item: { readonly reacts?: readonly ReactionEvent[] }): Reaction[] => reactionsOf(item.reacts ?? []);

/** Where in the log the chat item is (the newest with that id: -1, none). */
function indexOf(log: readonly LogItem[], channel: string, id: string): number {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]!;
    if (l.type === 'chat' && l.id === id && l.channel === channel) return i;
  }
  return -1;
}

/** The chat item a reaction is for, if this log has it. */
export function chatItemOf(log: readonly LogItem[], channel: string, id: string): ChatItem | undefined {
  const item = log[indexOf(log, channel, id)];
  return item?.type === 'chat' ? item : undefined;
}

/** The log with the change taken in: the same log when its message isn't here or the change is older than what's there. */
export function reactOnLog(log: readonly LogItem[], a: ChatReactAction): readonly LogItem[] {
  const at = indexOf(log, a.channel, a.id);
  const item = log[at];
  if (!item || item.type !== 'chat') return log;
  const next = applyReaction(item.reacts ?? [], { id: a.id, emoji: a.emoji, by: a.by, on: a.on, at: a.at });
  if (!next) return log;
  return log.map((l, i) => (i === at ? { ...item, reacts: next } : l));
}
