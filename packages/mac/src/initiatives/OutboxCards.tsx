import { useState } from 'react';
import { DRAFT_KIND_WORDS, type InitiativeView, type OutboxDraft, pendingDrafts, targetWords, textMaxOf } from '@beluga/core/initiatives/model.js';
import { TextArea } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const KIND_ICON: Readonly<Record<OutboxDraft['to']['kind'], IconName>> = { slack: 'chat', jira: 'issue', confluence: 'fileText', 'confluence-page': 'fileText', prep: 'calendar' };

type CardProps = {
  readonly slug: string;
  readonly draft: OutboxDraft;
  readonly place?: string;
  readonly onLater?: () => void;
};

/** One draft: Send (or, for a prep sheet that is never sent, Copy as Markdown and Done), with the text as you edit it. */
export const OutboxCard = ({ slug, draft, place, onLater }: CardProps) => {
  const a = useInitiativeActions();
  const [text, setText] = useState(draft.sentText ?? draft.text);
  const sending = draft.state === 'approved';
  const prep = draft.to.kind === 'prep';
  const max = textMaxOf(draft.to);
  const handleSend = (): void => void a.act(() => a.api.sendDraft(slug, draft.id, text), 'Sending it from the chat');
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
        <TextArea value={text} onChange={setText} rows={prep ? 8 : 5} maxLength={max} aria-label={`${DRAFT_KIND_WORDS[draft.to.kind]} to ${targetWords(draft.to)}`} />
      )}
      {sending ? <span className={s.why}>Sent to the chat to post. If it didn’t go out, send it again.</span> : null}
      {prep ? <span className={s.why}>Never sent: take it into the meeting, then mark it Done.</span> : null}
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
            {sending ? 'Send Again' : 'Send'}
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

/** The initiative's outbox above the chat's message box: one draft at a time, sent, edited or discarded by you. */
export const OutboxCards = ({ item }: { item: InitiativeView }) => {
  const drafts = pendingDrafts(item);
  const [at, setAt] = useState(0);
  if (!drafts.length) return null;
  const index = at % drafts.length;
  const draft = drafts[index]!;
  const handleLater = (): void => setAt(index + 1);
  return (
    <div className={s.outbox} role="region" aria-label="Outbox">
      <OutboxCard key={draft.id} slug={item.slug} draft={draft} place={`${index + 1} of ${drafts.length}`} {...(drafts.length > 1 ? { onLater: handleLater } : {})} />
    </div>
  );
};
