import { useMemo } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { CHECK_IN_CHAT, type InitiativeView, initiativeChatOf, initiativeChatTitle } from '@beluga/core/initiatives/model.js';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { Attention } from '../chat/Attention.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Composer } from '../chat/Composer.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Empty, IconButton, Tip } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { OutboxCards } from './OutboxCards.js';
import { useInitiativeActions } from './use-initiatives.js';
import v from '../views/views.module.css';
import chat from '../sentinel/sentinel.module.css';
import s from './initiatives.module.css';

const STARTERS: readonly string[] = ['Where does this stand?', 'What should I decide this week?', 'Who is blocked, and on what?'];

export const InitiativeChat = ({ item }: { item: InitiativeView }) => {
  const view = useApp((st) => st.view);
  const channel = channelOf(view);
  const id = initiativeChatOf(channel)?.chat ?? item.chats.active;
  const actions = useActions();
  const a = useInitiativeActions();
  const titles = useApp((st) => JSON.stringify(item.chats.chats.map((c) => initiativeChatTitle(c.channel, st.log))));
  const names = useMemo(() => JSON.parse(titles) as string[], [titles]);
  const busy = useApp((st) => activityOf(st.log, channel).running);
  const name = names[item.chats.chats.findIndex((c) => c.id === id)] ?? 'New chat';
  const handleOpen = (next: string): void => {
    void a.act(() => a.api.chatOpen(item.slug, next));
    a.open(item, next);
  };
  const handleNew = async (): Promise<void> => {
    const made = await a.act(() => a.api.chatNew(item.slug));
    if (made) a.open(item, made.id);
  };
  const handleDelete = (): void =>
    openSheet({
      kind: 'confirm',
      title: `Delete “${name}”?`,
      message: 'Its messages and the agent’s memory of it go for good. The initiative’s files stay as they are.',
      confirm: 'Delete Chat',
      destructive: true,
      run: () => void a.act(() => a.api.chatDelete(item.slug, id), 'Deleted the chat').then(() => a.open(item, 'main')),
    });
  const more: ActionItem[] = [
    { label: 'New Chat', icon: 'plus', onSelect: () => void handleNew() },
    { label: 'Delete Chat…', danger: true, separate: true, disabled: id === CHECK_IN_CHAT, hint: id === CHECK_IN_CHAT ? 'The check-in wakes this chat' : undefined, onSelect: handleDelete },
  ];
  const starters = (
    <div className={s.chips}>
      {STARTERS.map((prompt) => (
        <button key={prompt} type="button" className={s.file} onClick={() => actions.submit(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  );
  return (
    <div className={chat.chatTab} data-initiative-chat={id}>
      <div className={chat.chatBar}>
        <PickMenu<string> label="Chats" choices={item.chats.chats.map((c, i) => ({ value: c.id, label: names[i] ?? 'New chat', mark: <Icon name={c.id === CHECK_IN_CHAT ? 'calendar' : 'chat'} size={13} /> }))} chosen={[id]} onPick={handleOpen} actions={[{ label: 'New Chat', icon: 'plus', onSelect: () => void handleNew() }]}>
          <button type="button" className={chat.chatName} aria-label={`Chat: ${name}`}>
            <Icon name="chat" size={13} />
            <span>{name}</span>
            <Icon name="chevronDown" size={10} />
          </button>
        </PickMenu>
        {busy ? <span className={chat.chatBusy}>Working…</span> : null}
        <span className={chat.grow} />
        <Tip label="A new conversation beside this one">
          <IconButton size="small" icon="plus" label="New Chat" onClick={() => void handleNew()} />
        </Tip>
        <ActionsDropdown items={more}>
          <IconButton size="small" icon="more" label="More for this chat" />
        </ActionsDropdown>
      </div>
      <div className={v.chat} data-drop-zone>
        <ChatLog key={channel} channel={channel} empty={<Empty icon="claude" title="Ask about this initiative" detail="Your agent reads its memory first, and suggests before it acts outward." action={starters} />} />
        <Attention channel={channel} />
        <OutboxCards item={item} />
        <Composer />
      </div>
    </div>
  );
};
