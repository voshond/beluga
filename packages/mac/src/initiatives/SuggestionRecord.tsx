import type { ReactNode } from 'react';
import { type InitiativeView, type Suggestion, initiativeChatOf, isDecision, linkOf } from '@beluga/core/initiatives/model.js';
import { LOG_STATE_LABEL, type LogSource, dayOfIso, logStateOf, proofOf, recordMarkdown, sourcesOf } from '@beluga/core/initiatives/log.js';
import { Button } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { openExternal } from '../lib/system.js';
import { DecisionAnswers } from './DecisionRow.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

type RecordProps = { readonly item: InitiativeView; readonly suggestion: Suggestion };

const KIND_LABEL: Readonly<Record<Suggestion['kind'], string>> = { jira: 'Jira', slack: 'Slack', calendar: 'Calendar', task: 'Task', doc: 'Doc', decision: 'Decision', other: 'Other' };

export const KindChip = ({ suggestion }: { suggestion: Suggestion }) => (
  <span className={s.kindChip} data-kind={isDecision(suggestion) ? 'decision' : suggestion.kind}>
    {isDecision(suggestion) ? KIND_LABEL.decision : KIND_LABEL[suggestion.kind]}
  </span>
);

export const StateBadge = ({ suggestion }: { suggestion: Suggestion }) => {
  const state = logStateOf(suggestion);
  return (
    <span className={s.stateBadge} data-state={state}>
      {LOG_STATE_LABEL[state]}
    </span>
  );
};

const LinkLine = ({ link }: { link: LogSource }) => {
  const url = link.url ? linkOf(link.url) : undefined;
  const handleOpen = (): void => {
    if (url) void openExternal(url);
  };
  if (!url) return <li>{link.label}</li>;
  return (
    <li>
      <button type="button" className={s.proofLink} onClick={handleOpen} title={url} aria-label={`Open ${link.label}`}>
        {link.label}
      </button>
    </li>
  );
};

const LinkList = ({ links }: { links: readonly LogSource[] }) => (
  <ul className={s.proofList}>
    {links.map((link) => (
      <LinkLine key={link.url ?? link.label} link={link} />
    ))}
  </ul>
);

const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <>
    <span className={s.recordLabel}>{title}</span>
    <div className={s.recordText}>{children}</div>
  </>
);

const OpenActions = ({ item, suggestion }: RecordProps) => {
  const a = useInitiativeActions();
  const handleApprove = (): void => void a.act(() => a.api.resolveSuggestion(item.slug, suggestion.id, 'approve'), 'Sent to the chat');
  const handleDismiss = (): void => void a.act(() => a.api.resolveSuggestion(item.slug, suggestion.id, 'dismiss'));
  const handleClarify = (): void =>
    void a.act(() => a.api.clarifySuggestion(item.slug, suggestion.id), 'Asked in the chat').then((done) => {
      const chat = initiativeChatOf(done?.channel)?.chat;
      if (chat) a.open(item, chat);
    });
  return (
    <div className={s.recordActions}>
      {isDecision(suggestion) ? <DecisionAnswers slug={item.slug} suggestion={suggestion} /> : null}
      <span className={s.recordButtons}>
        <Button size="small" variant="quiet" onClick={handleDismiss} aria-label={`Dismiss: ${suggestion.text}`}>
          Dismiss
        </Button>
        <span className={s.grow} />
        <Button size="small" onClick={handleClarify} aria-label={`Clarify in chat: ${suggestion.text}`}>
          Clarify in chat
        </Button>
        {isDecision(suggestion) ? null : (
          <Button size="small" variant="primary" onClick={handleApprove} aria-label={`Approve: ${suggestion.text}`}>
            Approve
          </Button>
        )}
      </span>
    </div>
  );
};

export const SuggestionRecord = ({ item, suggestion }: RecordProps) => {
  const a = useInitiativeActions();
  const open = suggestion.state === 'open';
  const proof = proofOf(suggestion, item.outbox);
  const sources = sourcesOf(suggestion, item);
  const handleCopy = (): void => void a.act(() => copyText(recordMarkdown(suggestion, item)), 'Copied the record');
  return (
    <article className={`${s.record} selectable`} data-record={suggestion.id} aria-label={`Suggestion ${suggestion.id}`}>
      <span className={s.recordHead}>
        <span className={s.recordId}>#{suggestion.id}</span>
        <KindChip suggestion={suggestion} />
        <StateBadge suggestion={suggestion} />
        {open && suggestion.clarifiedAt ? <span className={s.inChat}>In chat</span> : null}
        <span className={s.grow} />
        {open ? null : (
          <Button size="small" variant="quiet" icon="copy" onClick={handleCopy}>
            Copy as Markdown
          </Button>
        )}
      </span>
      <h3 className={s.recordTitle}>{suggestion.text}</h3>
      {suggestion.why ? <Part title="Context">{suggestion.why}</Part> : null}
      {sources.length ? (
        <Part title="Sources">
          <LinkList links={sources} />
        </Part>
      ) : null}
      {open ? (
        <OpenActions item={item} suggestion={suggestion} />
      ) : (
        <>
          <Part title="Decision">
            {suggestion.answer ?? LOG_STATE_LABEL[logStateOf(suggestion)]}
            {suggestion.resolvedAt ? <span className={s.recordDate}> on {dayOfIso(suggestion.resolvedAt)}</span> : null}
          </Part>
          <Part title="Outcome">{suggestion.outcome ?? (suggestion.state === 'dismissed' ? 'Not done.' : 'The chat has not written one yet.')}</Part>
          <Part title="Proof">
            {proof.length ? (
              <LinkList links={proof} />
            ) : (
              <span className={s.quiet}>None yet.</span>
            )}
          </Part>
        </>
      )}
    </article>
  );
};
