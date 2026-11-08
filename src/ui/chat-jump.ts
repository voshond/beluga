import type { ChatJump } from './keymap.js';

/** How long a jump waits for its conversation to show its message; after that it's not what you just asked for. */
export const JUMP_TTL_MS = 10_000;
/** How long the message you jumped to stays marked. */
export const JUMP_MARK_MS = 2_000;
/** Said when a jump can't find its row: the conversation keeps only its latest items (store.ts, LOG_LIMIT). */
export const JUMP_LOST_TEXT = 'That message is too old to show here. The chat shows its latest messages.';

export type ChatJumpState = { readonly state: 'none' | 'wait' | 'drop' | 'lost' } | { readonly state: 'go'; readonly index: number };

/** A row of the chat: its item, and which part of a turn split in two it draws (the tail holds the answer). */
export interface JumpRow {
  readonly id: string;
  readonly ts: number;
  readonly side?: 'head' | 'tail' | 'live';
}

/**
 * What a conversation does about a jump: scroll to a row, wait for its history to land (it comes
 * whole, so any rows mean it's here), say the row is too old to be there, or forget the jump: one
 * from a while ago, or one to a message the chat doesn't draw as a row (it waits in the queue,
 * it's a note on a steered message, the chat is empty).
 */
export function chatJumpState(jump: ChatJump | undefined, channel: string, rows: readonly JumpRow[], now: number): ChatJumpState {
  if (!jump || jump.channel !== channel) return { state: 'none' };
  if (now - jump.at > JUMP_TTL_MS) return { state: 'drop' };
  if (!rows.length) return { state: 'wait' };
  const match = (r: JumpRow): boolean => (jump.id ? r.id === jump.id : r.ts === jump.ts);
  // A hit on a turn is on its answer (search.ts reads a turn's text only).
  const tail = rows.findIndex((r) => r.side === 'tail' && match(r));
  const index = tail >= 0 ? tail : rows.findIndex(match);
  if (index >= 0) return { state: 'go', index };
  return rows.every((r) => jump.ts < r.ts) ? { state: 'lost' } : { state: 'drop' };
}
