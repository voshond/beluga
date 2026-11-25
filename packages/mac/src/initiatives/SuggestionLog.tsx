import { type ReactNode, useState } from 'react';
import { type InitiativeView, type Suggestion, openSuggestions, pendingDrafts } from '@beluga/core/initiatives/model.js';
import { dayOfIso, proofOf, suggestionHistory } from '@beluga/core/initiatives/log.js';
import { Section } from './InitiativeParts.js';
import { KindChip, StateBadge, SuggestionRecord } from './SuggestionRecord.js';
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

export const Suggestions = ({ item }: { item: InitiativeView }) => {
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);
  const open = openSuggestions(item);
  const history = suggestionHistory(item);
  const waiting = pendingDrafts(item).length;
  const selected = item.suggestions.find((x) => x.id === selectedId) ?? open[0] ?? history[0];
  return (
    <Section title="Suggestions">
      {waiting ? <span className={s.quiet}>{waiting === 1 ? 'A message is waiting for you in the chat’s outbox.' : `${waiting} messages are waiting for you in the chat’s outbox.`}</span> : null}
      {selected ? (
        <div className={s.log}>
          <div className={s.logMain}>
            <span className={s.logTitle}>Needs you · {open.length}</span>
            {open.length ? (
              <div role="listbox" aria-label="Open suggestions" className={s.logOpen}>
                {open.map((x) => (
                  <OpenRow key={x.id} suggestion={x} selected={x.id === selected.id} onSelect={setSelectedId} />
                ))}
              </div>
            ) : (
              <span className={`${s.quiet} ${s.logEmpty}`}>Nothing to approve or decide. The next check-in may suggest something.</span>
            )}
            <span className={s.logTitle}>Decision log · {history.length}</span>
            {history.length ? (
              <div role="listbox" aria-label="Decision log" className={s.logOpen}>
                {history.map((x) => (
                  <HistoryRow key={x.id} item={item} suggestion={x} selected={x.id === selected.id} onSelect={setSelectedId} />
                ))}
              </div>
            ) : (
              <span className={`${s.quiet} ${s.logEmpty}`}>What you approve, decide or dismiss is kept here.</span>
            )}
          </div>
          <SuggestionRecord item={item} suggestion={selected} />
        </div>
      ) : (
        <span className={s.quiet}>Nothing to approve or decide. The next check-in may suggest something.</span>
      )}
    </Section>
  );
};
