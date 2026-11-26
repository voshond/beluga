import type { DecisionNote } from '@beluga/core/initiatives/decisions.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { EntryText } from './InitiativeTimeline.js';
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
    {note.why ? <span className={s.noteWhy}>Why: {note.why}</span> : null}
  </div>
);

/** decisions.md's "## Open": the questions that wait on someone else, under the plain lines that group them. */
export const OpenQuestions = ({ item }: { item: InitiativeView }) => {
  if (!item.decisions) return null;
  const open = item.decisions.open;
  return (
    <>
      <span className={s.logTitle}>Waiting on others · {open.length}</span>
      {open.length ? (
        <div role="list" aria-label="Open questions" className={s.logOpen}>
          {open.map((note, i) => (
            <NoteRow key={`${i}:${note.text}`} note={note} item={item} chip="Question" heading={note.group !== open[i - 1]?.group ? note.group : undefined} />
          ))}
        </div>
      ) : (
        <span className={`${s.quiet} ${s.logEmpty}`}>No question waits on anyone else.</span>
      )}
    </>
  );
};
