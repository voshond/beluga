import { useMemo } from 'react';
import { chatReactions } from '@beluga/core/chat-reactions.js';
import { type LogItem, peerName } from '@beluga/core/store.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { isEarlierLine } from '../lib/said.js';
import { ReactButton, ReactionChips, useChatReact } from '../network/Reactions.js';

/**
 * Emoji reactions on a message of the room's group chat or a workspace chat (BLG-702), with the
 * same button and chips as friends' chats. An earlier line drawn as a message (a shared
 * workspace's history) has none: it isn't a message of its own here.
 */

type ChatItem = Extract<LogItem, { type: 'chat' }>;

/** Reactions belong to the room and to workspaces (your own Mac's chats aren't shared with anyone). */
export const canReact = (item: ChatItem): boolean => !isEarlierLine(item) && (item.channel === 'room' || item.channel.startsWith('ws:'));

/** The button and the chips for one chat message, or nothing for one that can't have them. */
export function useChatReactions(item: ChatItem, mine: boolean): { button: React.ReactNode; chips: React.ReactNode } {
  const { client } = useBeluga();
  const me = useApp((st) => st.selfId);
  const react = useChatReact(item.channel, item.id);
  const reactions = useMemo(() => chatReactions(item), [item.reacts]);
  if (!canReact(item)) return { button: null, chips: null };
  return {
    button: <ReactButton reactions={reactions} me={me} onReact={react} />,
    chips: <ReactionChips reactions={reactions} me={me} mine={mine} nameOf={(peerId) => peerName(client.store.getState(), peerId)} onReact={react} />,
  };
}
