import * as Popover from '@radix-ui/react-popover';
import { useMemo, useState } from 'react';
import type { MessageView } from '@beluga/net/mesh/views.js';
import { type Reaction, hasReacted, quickReactions, reactionsOf, reactorsLine } from '@beluga/shared/reactions.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { EmojiPicker } from './EmojiPicker.js';
import { errorText, quietly } from './use-net.js';
import r from './reactions.module.css';

/**
 * Emoji reactions on a chat message (BLG-702), as Slack has them: the chips under it (emoji and
 * count, who on hover, yours tinted; a click adds or takes back yours), and the button a hover
 * shows, with your six quick reactions and More for every emoji. The same for friends' chats
 * (`network.messages.react`) and the room's and workspaces' chats (`session.react`).
 */

/** Put an emoji on the message or take yours off (`on`; none flips it). */
export type OnReact = (emoji: string, on?: boolean) => void;

/** A failure is said in a toast. */
function useCall(): (call: Promise<unknown>) => void {
  const { client } = useBeluga();
  return (call) => void quietly(client, call).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn’t react: ${errorText(err)}`, level: 'error' }));
}

/** Reacting to a message in a friends' chat (a DM or a channel). */
export function useNetReact(m: MessageView): OnReact {
  const { client } = useBeluga();
  const call = useCall();
  return (emoji, on) => call(client.api.network['messages.react'](m.conversation, m.id, emoji, on));
}

/** Reacting to a message in the room's group chat or a workspace chat. */
export function useChatReact(channel: string, id: string): OnReact {
  const { client } = useBeluga();
  const call = useCall();
  return (emoji, on) => call(client.api.session.react(channel, id, emoji, on));
}

/** The chips under a message; nothing when it has none. `nameOf` says "you" for you. */
export function ReactionChips({ reactions, me, nameOf, mine, onReact }: { reactions: readonly Reaction[] | undefined; me?: string | undefined; nameOf: (peerId: string) => string; mine?: boolean; onReact: OnReact }) {
  if (!reactions?.length) return null;
  const who = (peerId: string): string => (peerId === me ? 'you' : nameOf(peerId));
  return (
    <div className={cx(r.chips, mine && r.chipsMine)} role="group" aria-label="Reactions">
      {reactions.map((x) => {
        const yours = Boolean(me && hasReacted(reactions, x.emoji, me));
        const line = `${reactorsLine(x.by, who, 8)} reacted with ${x.emoji}`;
        return (
          <Tip key={x.emoji} label={line} side="top">
            <button type="button" className={cx(r.chip, yours && r.chipMine)} aria-pressed={yours} aria-label={`${x.emoji} ${x.by.length}: ${line}${yours ? '. Click to take yours back' : '. Click to add yours'}`} onClick={() => onReact(x.emoji, !yours)} data-reaction={x.emoji}>
              <span className={r.chipEmoji}>{x.emoji}</span>
              <span className={r.chipCount}>{x.by.length}</span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** Your quick row: the emojis you use most in your chats (friends', the room's, workspaces'), then the defaults. */
function useQuickRow(): string[] {
  const messages = useApp((st) => st.network.messages);
  const log = useApp((st) => st.log);
  const ids = useApp((st) => `${st.selfId} ${st.network.self?.peerId ?? ''}`);
  return useMemo(() => {
    const inLog = log.flatMap((l) => (l.type === 'chat' && l.reacts?.length ? [{ reactions: reactionsOf(l.reacts) }] : []));
    return quickReactions([...Object.values(messages).flat(), ...inLog], ids.split(' ').filter(Boolean));
  }, [messages, log, ids]);
}

function ReactCard({ reactions, me, onReact, close }: { reactions: readonly Reaction[] | undefined; me: string | undefined; onReact: OnReact; close: () => void }) {
  const quick = useQuickRow();
  const [more, setMore] = useState(false);
  // As its chip does: one you already put there is taken back (it's tinted in the row).
  const pick = (emoji: string): void => {
    onReact(emoji);
    close();
  };
  if (more) return <EmojiPicker recent={quick} onPick={pick} />;
  return (
    <div className={r.quick} role="group" aria-label="React">
      {quick.map((e) => (
        <button key={e} type="button" className={cx(r.quickPick, me && hasReacted(reactions, e, me) && r.quickPicked)} aria-label={`React with ${e}`} onClick={() => pick(e)}>
          {e}
        </button>
      ))}
      <button type="button" className={r.quickMore} aria-label="More emoji" title="More emoji" onClick={() => setMore(true)}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

/** The button a hover over a message shows, at the top right of its row (as Slack has it). `me`: your id where reactions are kept. */
export function ReactButton({ reactions, me, onReact }: { reactions: readonly Reaction[] | undefined; me: string | undefined; onReact: OnReact }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx(r.react, open && r.reactOpen)}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Tip label="Add Reaction" side="top">
          <Popover.Trigger asChild>
            <button type="button" className={r.reactButton} aria-label="Add Reaction">
              <Icon name="smilePlus" size={15} />
            </button>
          </Popover.Trigger>
        </Tip>
        <Popover.Portal>
          <Popover.Content className={r.card} side="top" align="end" sideOffset={6} collisionPadding={10} aria-label="React to this message">
            <ReactCard reactions={reactions} me={me} onReact={onReact} close={() => setOpen(false)} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
