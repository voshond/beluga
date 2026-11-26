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

  const asked = watch ? `Asked ${watch.since.slice(0, 10)}` : undefined;
  const checkFailed = state === 'waiting' && watch?.checkFailed;
  return (
    <div role="listitem" className={s.task}>
      <span className={s.taskText}>
        <span className={s.taskTitle}><EntryText text={question.text} item={item} /></span>
        <span className={s.taskNotes}>
          <span>{label}</span>
          {asked ? <> · <span>{asked}</span></> : null}
        </span>
        {checkFailed ? <span className={s.riskLine}>Check has no confirmed result.</span> : null}
      </span>
      {source ? <IconButton size="small" icon="external" label="Open sent message" onClick={handleOpen} /> : null}
      <IconButton size="small" icon="pencil" label="Edit question" onClick={onEdit} />
    </div>
  );
};
