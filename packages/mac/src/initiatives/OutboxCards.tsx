import { useState } from 'react';
import { type InitiativeView, type OutboxDraft, pendingDrafts, targetWords } from '@beluga/core/initiatives/model.js';
import { TextArea } from '../components/FormSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const KIND_WORDS: Readonly<Record<OutboxDraft['to']['kind'], string>> = { slack: 'Slack', jira: 'Jira comment', confluence: 'Confluence page' };

const KIND_ICON: Readonly<Record<OutboxDraft['to']['kind'], IconName>> = { slack: 'chat', jira: 'issue', confluence: 'fileText' };

type CardProps = {
  readonly slug: string;
  readonly draft: OutboxDraft;
  readonly place: string;
  readonly onLater?: () => void;
};

const OutboxCard = ({ slug, draft, place, onLater }: CardProps) => {
  const a = useInitiativeActions();
  const [text, setText] = useState(draft.sentText ?? draft.text);
  const sending = draft.state === 'approved';
  const handleSend = (): void => void a.act(() => a.api.sendDraft(slug, draft.id, text), 'Sending it from the chat');
  const handleDiscard = (): void => void a.act(() => a.api.discardDraft(slug, draft.id), 'Discarded the draft');
  return (
    <div className={s.outboxCard} data-outbox={draft.id} data-state={draft.state} aria-label={`Draft to ${targetWords(draft.to)}`}>
      <div className={s.outboxHead}>
        <Icon name={KIND_ICON[draft.to.kind]} size={13} />
        <span className={s.outboxTo}>
          {KIND_WORDS[draft.to.kind]} · {targetWords(draft.to)}
        </span>
        <span className={s.grow} />
        <span className={s.quiet}>{place}</span>
      </div>
      {draft.why ? <span className={s.why}>{draft.why}</span> : null}
      {draft.to.kind === 'confluence' ? (
        <span className={s.why}>
          {draft.text} Sends {draft.to.file} as it is now{draft.to.page ? `, over page ${draft.to.page}` : ''}.
        </span>
      ) : (
        <TextArea value={text} onChange={setText} rows={5} maxLength={5000} aria-label={`Message to ${targetWords(draft.to)}`} />
      )}
      {sending ? <span className={s.why}>Sent to the chat to post. If it didn’t go out, send it again.</span> : null}
      <span className={s.answers}>
        <Button size="small" variant="primary" icon="send" onClick={handleSend} disabled={!text.trim()}>
          {sending ? 'Send Again' : 'Send'}
        </Button>
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
