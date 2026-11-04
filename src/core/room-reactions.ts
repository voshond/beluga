import type { BodyInput, BodyOf } from '../protocol.js';
import { type Reaction, reactionChange } from '../shared/reactions.js';
import { chatItemOf, chatReactions } from './chat-reactions.js';
import type { Store } from './store.js';
import type { WorkspaceSharing } from './workspace-sharing.js';

/**
 * Emoji reactions in the room's group chat and in workspace chats (BLG-702), on the Session's side:
 * your click goes into the shared state at once and out as a `chat_react` (into the room's history
 * for the room; to each person in a workspace, a friend's worktree through its owner's Mac), and
 * someone's change comes in only from who may see that chat. The rules are shared/reactions.ts's.
 */

export interface RoomReactDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to?: string; keep?: boolean }) => boolean;
  readonly sharing: Pick<WorkspaceSharing, 'recipients' | 'canSee'>;
  /** A workspace's saved conversation, loaded before a change to it is taken in. */
  readonly ensureLoaded?: (wsId: string) => void;
}

/** Chats reactions are kept in: the room and workspaces (your own agent's chats elsewhere aren't shared). */
const reactable = (channel: string): boolean => channel === 'room' || channel.startsWith('ws:');

/** Your click on `emoji` under chat message `id` (`on` says which way; none flips yours). → its chips now. */
export function reactInChat(deps: RoomReactDeps, channel: string, id: string, emoji: string, on?: boolean): Reaction[] {
  if (!reactable(channel)) throw new Error('Reactions are for the group chat and workspace chats');
  const item = chatItemOf(deps.store.getState().log, channel, id);
  if (!item) throw new Error('No such message');
  const me = deps.selfId();
  const last = item.reacts?.find((e) => e.emoji === emoji && e.by === me)?.at ?? 0;
  const change = reactionChange(chatReactions(item), { id, emoji, me, ...(on !== undefined ? { on } : {}), at: Math.max(Date.now(), last + 1) });
  const body = { kind: 'chat_react', channel, to: id, e: change.emoji, on: change.on, at: change.at } as const;
  // The room keeps it with its history, so people who come later see it too.
  if (channel === 'room' && !deps.send(body, { keep: true })) throw new Error('Not connected to the room, so the reaction didn’t go');
  deps.store.dispatch({ type: 'chat_react', channel, id, emoji: change.emoji, by: me, on: change.on, at: change.at });
  if (channel !== 'room') for (const to of deps.sharing.recipients(channel)) deps.send(body, { to });
  return chatReactions(chatItemOf(deps.store.getState().log, channel, id) ?? item);
}

/** Someone's change (its shape checked by the protocol): from anyone in the room, or anyone who sees the workspace. */
export function onChatReact(deps: RoomReactDeps, from: string, body: BodyOf<'chat_react'>): void {
  if (!reactable(body.channel)) return;
  if (body.channel !== 'room' && !deps.sharing.canSee(from, body.channel)) return;
  if (body.channel.startsWith('ws:')) deps.ensureLoaded?.(body.channel.slice(3));
  deps.store.dispatch({ type: 'chat_react', channel: body.channel, id: body.to, emoji: body.e, by: from, on: body.on, at: body.at });
}
