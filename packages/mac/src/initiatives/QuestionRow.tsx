import type { SourceContext } from '@beluga/core/initiatives/log.js';
import { type Question, questionState } from '@beluga/core/initiatives/questions.js';
import type { Watch } from '@beluga/core/initiatives/watches.js';
import { Button } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import { EntryText } from './InitiativeTimeline.js';
import s from './initiatives.module.css';

type Props = {
  readonly question: Question;
  readonly watch?: Watch;
  readonly item: SourceContext;
  readonly hasDraft?: boolean;
  readonly onEdit: () => void;
};

const waitingLabel = (person?: string): string => person ? `Waiting for ${person}` : 'Waiting for reply';

export const QuestionRow = ({ question, watch, item, hasDraft, onEdit }: Props) => {
  const state = questionState(question, watch);
  const label = state === 'waiting' ? waitingLabel(question.waitingOn)
    : state === 'inactive' ? 'Tracking ended'
    : hasDraft ? 'Draft ready'
    : 'Needs outreach';
  const source = watch?.source;
  const handleOpen = (): void => {
    if (source) void openExternal(source);
  };

  return (
    <div role="listitem" className={s.noteItem}>
      <span className={s.logItemTop}>
        <span className={s.kindChip} data-kind="note">{label}</span>
        {watch ? <span className={s.quiet}>{`Asked ${watch.since.slice(0, 10)}`}</span> : null}
        <span className={s.grow} />
        <Button size="small" variant="quiet" icon="pencil" aria-label="Edit question" onClick={onEdit}>Edit</Button>
      </span>
      <EntryText text={question.text} item={item} />
      {state === 'waiting' && watch?.checkFailed
        ? <span className={s.quiet}>Check has no confirmed result.</span> : null}
      {source ? <Button size="small" variant="quiet" icon="external" onClick={handleOpen}>Open sent message</Button> : null}
    </div>
  );
};
