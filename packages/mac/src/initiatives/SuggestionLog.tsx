import { type KeyboardEvent, useState } from 'react';
import { type InitiativeView, type Suggestion, openSuggestions, pendingDrafts } from '@beluga/core/initiatives/model.js';
import { dayOfIso, proofOf, suggestionHistory } from '@beluga/core/initiatives/log.js';
import { Section } from './InitiativeParts.js';
import { KindChip, StateBadge, SuggestionRecord } from './SuggestionRecord.js';
import s from './initiatives.module.css';

type PickProps = { readonly suggestion: Suggestion; readonly selected: boolean; readonly onSelect: (id: number) => void };

const OpenRow = ({ suggestion, selected, onSelect }: PickProps) => {
  const handleClick = (): void => onSelect(suggestion.id);
  return (
    <button type="button" role="option" aria-selected={selected} className={s.logItem} onClick={handleClick} data-suggestion={suggestion.id}>
      <span className={s.logItemTop}>
        <KindChip suggestion={suggestion} />
        {suggestion.clarifiedAt ? <span className={s.inChat}>In chat</span> : null}
        <span className={s.grow} />
        <span className={s.logDate}>{dayOfIso(suggestion.createdAt).slice(5)}</span>
      </span>
      <span className={s.logItemText}>{suggestion.text}</span>
    </button>
  );
};

const HistoryRow = ({ item, suggestion, selected, onSelect }: PickProps & { readonly item: InitiativeView }) => {
  const handleClick = (): void => onSelect(suggestion.id);
  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onSelect(suggestion.id);
  };
  const proof = proofOf(suggestion, item.outbox).length;
  return (
    <tr aria-selected={selected} tabIndex={0} onClick={handleClick} onKeyDown={handleKeyDown} data-suggestion={suggestion.id}>
      <td className={s.logDate}>{dayOfIso(suggestion.resolvedAt)}</td>
      <td className={s.logCellText}>
        <KindChip suggestion={suggestion} /> {suggestion.text}
      </td>
      <td>
        <StateBadge suggestion={suggestion} />
      </td>
      <td className={s.quiet}>{proof || '—'}</td>
    </tr>
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
              <table className={s.logTable} aria-label="Decision log">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Suggestion</th>
                    <th>Result</th>
                    <th>Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((x) => (
                    <HistoryRow key={x.id} item={item} suggestion={x} selected={x.id === selected.id} onSelect={setSelectedId} />
                  ))}
                </tbody>
              </table>
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
