import { useLayoutEffect, useRef, useState } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { DRAFT_KIND_WORDS, type InitiativeView, type OutboxDraft, initiativeChatOf, pendingDrafts, targetWords, textMaxOf } from '@beluga/core/initiatives/model.js';
import { watchesReply } from '@beluga/core/initiatives/watches.js';
import { Checkbox } from '../components/Alert.js';
import { TextArea } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button, Working } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const KIND_ICON: Readonly<Record<OutboxDraft['to']['kind'], IconName>> = { slack: 'chat', jira: 'issue', confluence: 'fileText', 'confluence-page': 'fileText', prep: 'calendar' };

/** The share of the window a draft's text may grow to before it scrolls. */
const TEXT_SHARE = 0.4;

/** Sent by the user and still on its way: the chat is posting it, and nothing failed yet. */
const isSending = (draft: OutboxDraft): boolean => draft.state === 'approved' && !draft.sendError;

type CardProps = {
  readonly item: InitiativeView;
  readonly draft: OutboxDraft;
  readonly place?: string;
  readonly onLater?: () => void;
};

/** A draft on its way: where it goes and what it says, with nothing to press until it is out or failed. */
const OutboxSending = ({ draft }: Pick<CardProps, 'draft'>) => (
  <div className={s.outboxCard} data-outbox={draft.id} data-state="sending" aria-busy aria-label={`Sending to ${targetWords(draft.to)}`}>
    <div className={s.outboxHead}>
      <Icon name={KIND_ICON[draft.to.kind]} size={13} />
      <span className={s.outboxTo}>
        {DRAFT_KIND_WORDS[draft.to.kind]} · {targetWords(draft.to)}
      </span>
      <span className={s.grow} />
      <Working />
      <span className={s.quiet}>Sending…</span>
    </div>
    <span className={s.outboxSent}>{draft.sentText ?? draft.text}</span>
  </div>
);

/** One draft: Send (or, for a prep sheet that is never sent, Copy as Markdown and Done), with the text as you edit it. */
export const OutboxCard = (props: CardProps) => (isSending(props.draft) ? <OutboxSending draft={props.draft} /> : <OutboxDraftCard {...props} />);

const OutboxDraftCard = ({ item, draft, place, onLater }: CardProps) => {
  const a = useInitiativeActions();
  const slug = item.slug;
  const viewed = useApp((st) => (st.view.kind === 'initiative_page' && st.view.slug === slug ? initiativeChatOf(channelOf(st.view))?.chat : undefined));
  const [text, setText] = useState(draft.sentText ?? draft.text);
  const [watch, setWatch] = useState(watchesReply(draft));
  const area = useRef<HTMLTextAreaElement>(null);
  // Tall enough to read the whole message, up to a share of the window; never shorter than you dragged it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const frame = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + frame, Math.round(window.innerHeight * TEXT_SHARE))}px`;
  }, [text]);
  const failed = draft.state === 'approved';
  const prep = draft.to.kind === 'prep';
  const max = textMaxOf(draft.to);
  const canWatch = (draft.to.kind === 'slack' || draft.to.kind === 'jira') && !draft.question && !draft.reminderFor;
  const handleSend = (): void =>
    void a.act(() => a.api.sendDraft(slug, draft.id, text, canWatch ? watch : undefined, viewed), 'Sending it from the chat').then((done) => {
      const chat = initiativeChatOf(done?.channel)?.chat;
      if (chat && chat !== viewed) a.open(item, chat);
    });
  const handleDiscard = (): void => void a.act(() => a.api.discardDraft(slug, draft.id), 'Discarded the draft');
  const handleCopy = (): void => void a.act(() => copyText(text), 'Copied the prep sheet');
  const handleDone = (): void => void a.act(() => a.api.keepPrep(slug, draft.id, text), 'Kept the prep sheet');
  return (
    <div className={s.outboxCard} data-outbox={draft.id} data-state={draft.state} aria-label={`Draft to ${targetWords(draft.to)}`}>
      <div className={s.outboxHead}>
        <Icon name={KIND_ICON[draft.to.kind]} size={13} />
        <span className={s.outboxTo}>
          {DRAFT_KIND_WORDS[draft.to.kind]} · {targetWords(draft.to)}
        </span>
        <span className={s.grow} />
        {place ? <span className={s.quiet}>{place}</span> : null}
      </div>
      {draft.why ? <span className={s.why}>{draft.why}</span> : null}
      {draft.to.kind === 'confluence-page' ? (
        <span className={s.why}>
          {draft.text} Sends {draft.to.file} as it is now{draft.to.page ? `, over page ${draft.to.page}` : ''}.
        </span>
      ) : (
        <TextArea ref={area} value={text} onChange={setText} rows={prep ? 8 : 5} maxLength={max} aria-label={`${DRAFT_KIND_WORDS[draft.to.kind]} to ${targetWords(draft.to)}`} />
      )}
      {draft.sendError ? <span role="alert" className={s.why}>{draft.sendError}</span> : null}
      {prep ? <span className={s.why}>Never sent: take it into the meeting, then mark it Done.</span> : null}
      {canWatch ? <Checkbox checked={watch} onChange={setWatch} label="Watch for an answer" /> : null}
      <span className={s.answers}>
        {prep ? (
          <>
            <Button size="small" variant="primary" icon="copy" onClick={handleCopy} disabled={!text.trim()}>
              Copy as Markdown
            </Button>
            <Button size="small" icon="check" onClick={handleDone} disabled={!text.trim()}>
              Done
            </Button>
          </>
        ) : (
          <Button size="small" variant="primary" icon="send" onClick={handleSend} disabled={!text.trim() || text.length > max}>
            {failed ? 'Send Again' : 'Send'}
          </Button>
        )}
        <Button size="small" variant="quiet" onClick={handleDiscard}>
          Discard
        </Button>
        <span className={s.grow} />
        {onLater ? (
          <Button size="small" variant="quiet" onClick={onLater}>
            Later
          </Button>
        ) : null}
      </span>
    </div>
  );
};

/** The initiative's outbox above the chat's message box: a line per draft on its way, then one draft at a time, sent, edited or discarded by you. */
export const OutboxCards = ({ item }: { item: InitiativeView }) => {
  const pending = pendingDrafts(item);
  const sending = pending.filter(isSending);
  const drafts = pending.filter((draft) => !isSending(draft));
  const [at, setAt] = useState(0);
  if (!pending.length) return null;
  const index = drafts.length ? at % drafts.length : 0;
  const draft = drafts[index];
  const handleLater = (): void => setAt(index + 1);
  return (
    <div className={s.outbox} role="region" aria-label="Outbox">
      {sending.map((sent) => (
        <OutboxSending key={sent.id} draft={sent} />
      ))}
      {draft ? <OutboxCard key={draft.id} item={item} draft={draft} place={`${index + 1} of ${drafts.length}`} {...(drafts.length > 1 ? { onLater: handleLater } : {})} /> : null}
    </div>
  );
};
