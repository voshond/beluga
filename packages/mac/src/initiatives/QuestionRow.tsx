import type { KeyboardEvent, MouseEvent } from 'react';
import type { SourceContext } from '@beluga/core/initiatives/log.js';
import { type Question, questionState } from '@beluga/core/initiatives/questions.js';
import type { Watch } from '@beluga/core/initiatives/watches.js';
import { IconButton } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import { EntryText } from './InitiativeTimeline.js';
import s from './initiatives.module.css';

type Props = {
  readonly question: Question;
  readonly watch?: Watch;
  readonly item: SourceContext;
  readonly hasDraft?: boolean;
  readonly onEdit: () => void;
  readonly onResolve: () => void;
  readonly onDelete: () => void;
};

const waitingLabel = (person?: string): string => person ? `Waiting for ${person}` : 'Waiting for reply';

const stop = (run: () => void) => (e: MouseEvent): void => {
  e.stopPropagation();
  run();
};

/** An open question as a row like the suggestions above it: its state and date on top, the question below; click it to edit. */
export const QuestionRow = ({ question, watch, item, hasDraft, onEdit, onResolve, onDelete }: Props) => {
  const state = questionState(question, watch);
  const label = state === 'waiting' ? waitingLabel(question.waitingOn)
    : state === 'inactive' ? 'Tracking ended'
    : hasDraft ? 'Draft ready'
    : 'Needs outreach';
  const source = watch?.source;
  const checkFailed = state === 'waiting' && watch?.checkFailed;
  const handleOpen = (): void => {
    if (source) void openExternal(source);
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onEdit();
  };

  return (
    <div role="listitem" tabIndex={0} aria-label={`Edit question: ${question.text}`} className={s.logItem} onClick={onEdit} onKeyDown={handleKeyDown} data-question={question.id}>
      <span className={s.logItemTop}>
        <span className={s.kindChip} data-kind="question">{label}</span>
        {checkFailed ? <span className={s.riskLine}>Check has no confirmed result.</span> : null}
        <span className={s.grow} />
        {source ? <IconButton size="small" icon="external" label="Open sent message" onClick={stop(handleOpen)} /> : null}
        <IconButton size="small" icon="check" label="Resolve question" onClick={stop(onResolve)} />
        <IconButton size="small" icon="trash" label="Delete question" onClick={stop(onDelete)} />
        <span className={s.logDate}>{(watch?.since ?? question.createdAt).slice(5, 10)}</span>
      </span>
      <span className={s.logItemText}><EntryText text={question.text} item={item} /></span>
    </div>
  );
};
