import type { ReactNode } from 'react';
import { type InitiativeView, type Suggestion, openSuggestions, pendingDrafts } from '@beluga/core/initiatives/model.js';
import { decisionLog } from '@beluga/core/initiatives/decisions.js';
import { dayOfIso, proofOf } from '@beluga/core/initiatives/log.js';
import { NoteRow, OpenQuestions } from './DecisionNotes.js';
import { Section } from './InitiativeParts.js';
import { KindChip, StateBadge } from './SuggestionRecord.js';
import s from './initiatives.module.css';

type PickProps = { readonly suggestion: Suggestion; readonly selected: boolean; readonly onSelect: (id: number) => void };

type LogRowProps = PickProps & { readonly date: string | undefined; readonly badges: ReactNode };

const LogRow = ({ suggestion, selected, onSelect, date, badges }: LogRowProps) => {
  const handleClick = (): void => onSelect(suggestion.id);
  return (
    <button type="button" role="option" aria-selected={selected} className={s.logItem} onClick={handleClick} data-suggestion={suggestion.id}>
      <span className={s.logItemTop}>
        <KindChip suggestion={suggestion} />
        {badges}
        <span className={s.grow} />
        <span className={s.logDate}>{dayOfIso(date).slice(5)}</span>
      </span>
      <span className={s.logItemText}>{suggestion.text}</span>
    </button>
  );
};

const OpenRow = (props: PickProps) => (
  <LogRow {...props} date={props.suggestion.createdAt} badges={props.suggestion.clarifiedAt ? <span className={s.inChat}>In chat</span> : null} />
);

const HistoryRow = ({ item, ...props }: PickProps & { readonly item: InitiativeView }) => {
  const proof = proofOf(props.suggestion, item.outbox).length;
  return (
    <LogRow
      {...props}
      date={props.suggestion.resolvedAt}
      badges={
        <>
          <StateBadge suggestion={props.suggestion} />
          {proof ? <span className={s.logProof}>{proof === 1 ? '1 proof' : `${proof} proofs`}</span> : null}
        </>
      }
    />
  );
};

type SuggestionsProps = { readonly item: InitiativeView; readonly pickedId: number | undefined; readonly onPick: (id: number) => void };

export const Suggestions = ({ item, pickedId, onPick }: SuggestionsProps) => {
  const open = openSuggestions(item);
  const history = decisionLog(item);
  const waiting = pendingDrafts(item).length;
  return (
    <Section title="Suggestions">
      {waiting ? <span className={s.quiet}>{waiting === 1 ? 'A message is waiting for you in the chat’s outbox.' : `${waiting} messages are waiting for you in the chat’s outbox.`}</span> : null}
      <div className={s.log}>
        <span className={s.logTitle}>Needs you · {open.length}</span>
        {open.length ? (
          <div role="listbox" aria-label="Open suggestions" className={s.logOpen}>
            {open.map((x) => (
              <OpenRow key={x.id} suggestion={x} selected={x.id === pickedId} onSelect={onPick} />
            ))}
          </div>
        ) : (
          <span className={`${s.quiet} ${s.logEmpty}`}>Nothing to approve or decide. The next check-in may suggest something.</span>
        )}
        <OpenQuestions item={item} />
        <span className={s.logTitle}>Decision log · {history.length}</span>
        {history.length ? (
          <div role="listbox" aria-label="Decision log" className={s.logOpen}>
            {history.map((x, i) =>
              x.kind === 'suggestion' ? (
                <HistoryRow key={x.suggestion.id} item={item} suggestion={x.suggestion} selected={x.suggestion.id === pickedId} onSelect={onPick} />
              ) : (
                <NoteRow key={`note:${i}`} note={x.note} item={item} chip="Note" badge="Decided" inListbox />
              ),
            )}
          </div>
        ) : (
          <span className={`${s.quiet} ${s.logEmpty}`}>What you approve, decide or dismiss is kept here.</span>
        )}
      </div>
    </Section>
  );
};
