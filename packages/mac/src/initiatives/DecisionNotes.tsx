import { useState } from 'react';
import type { Question } from '@beluga/core/initiatives/questions.js';
import { questionWatch } from '@beluga/core/initiatives/questions.js';
import { initiativeChatOf } from '@beluga/core/initiatives/model.js';
import type { DecisionNote } from '@beluga/core/initiatives/decisions.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { EntryText } from './InitiativeTimeline.js';
import { Button } from '../components/ui.js';
import { QuestionSheet } from './QuestionSheet.js';
import { QuestionRow } from './QuestionRow.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

type NoteProps = { readonly note: DecisionNote; readonly item: InitiativeView; readonly chip: string; readonly badge?: string; readonly heading?: string; readonly inListbox?: boolean };

/** A line of decisions.md: its day, its words with what they mention linked, and its reason. */
export const NoteRow = ({ note, item, chip, badge, heading, inListbox }: NoteProps) => (
  <div role={inListbox ? 'option' : 'listitem'} aria-selected={inListbox ? false : undefined} aria-disabled={inListbox ? true : undefined} className={s.noteItem}>
    {heading ? <span className={s.noteGroupTitle}>{heading}</span> : null}
    <span className={s.logItemTop}>
      <span className={s.kindChip} data-kind="note">
        {chip}
      </span>
      {badge ? (
        <span className={s.stateBadge} data-state="decided">
          {badge}
        </span>
      ) : null}
      <span className={s.grow} />
      <span className={s.logDate}>{note.day.slice(5)}</span>
    </span>
    <EntryText text={note.text} item={item} />
    {note.why ? <span className={s.noteWhy}>{note.question ? 'Answer' : 'Why'}: {note.why}</span> : null}
    {note.source ? <EntryText text={note.source} item={item} /> : null}
  </div>
);

export const OpenQuestions = ({ item }: { item: InitiativeView }) => {
  const actions = useInitiativeActions();
  const [editing, setEditing] = useState<Question | 'new'>();
  const open = (item.questions ?? []).filter((question) => !question.answer);
  const handleAdd = (): void => setEditing('new');
  const handleClose = (): void => setEditing(undefined);
  const handleOpenChat = (channel: string): void => {
    actions.open(item, initiativeChatOf(channel)?.chat);
  };

  return (
    <>
      <div className={s.logItemTop}>
        <span className={s.logTitle}>{`Open questions · ${open.length}`}</span>
        <span className={s.grow} />
        <Button size="small" variant="quiet" icon="plus" onClick={handleAdd}>Add question</Button>
      </div>
      {open.length ? (
        <div role="list" aria-label="Open questions" className={s.logOpen}>
          {open.map((question) => (
            <QuestionRow key={question.id} question={question} item={item} watch={questionWatch(question.id, item.watches ?? [])}
              hasDraft={item.outbox.some((draft) => draft.question === question.id && (draft.state === 'draft' || draft.state === 'approved'))}
              onEdit={() => setEditing(question)} />
          ))}
        </div>
      ) : null}
      {editing ? <QuestionSheet key={editing === 'new' ? 'new' : editing.id} item={item} question={editing === 'new' ? undefined : editing} close={handleClose} openChat={handleOpenChat} /> : null}
    </>
  );
};
