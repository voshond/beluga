import type { ReactNode } from 'react';
import { type EpicStatus, type InitiativeView, epicTitleOf, epicUrlOf } from '@beluga/core/initiatives/model.js';
import { openExternal } from '../lib/system.js';
import { progressDetail, progressPercent, progressWords, timelineDays } from './initiatives-model.js';
import s from './initiatives.module.css';

export const ProgressBar = ({ progress }: { progress: EpicStatus | undefined }) => {
  const percent = progressPercent(progress);
  return (
    <span className={s.progress}>
      <span className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={progressWords(progress)}>
        <span className={s.barFill} data-part="done" style={{ width: `${percent}%` }} />
        <span className={s.barFill} data-part="inProgress" style={{ width: `${progressPercent(progress, 'inProgress')}%` }} />
      </span>
      <span className={s.progressLine}>
        <span>{progressWords(progress)}</span>
        {progressDetail(progress).map((part) => (
          <span key={part}>{part}</span>
        ))}
      </span>
    </span>
  );
};

export const EpicLink = ({ epic, item }: { epic: string; item: Pick<InitiativeView, 'tickets' | 'progress'> }) => {
  const url = epicUrlOf(epic, item.tickets);
  const title = epicTitleOf(epic, item);
  const handleOpen = (): void => {
    if (url) void openExternal(url);
  };
  return (
    <button type="button" className={s.epicLink} data-epic-link={epic} onClick={handleOpen} disabled={!url} title={url} aria-label={url ? `Open epic ${epic} in Jira${title ? `: ${title}` : ''}` : `Epic ${epic}`}>
      <span className={s.epicName}>{epic}</span>
      {title ? <span className={s.epicTitle}>{title}</span> : null}
    </button>
  );
};

export const Section = ({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) => (
  <section className={s.section} aria-label={title}>
    <div className={s.sectionHead}>
      <span>{title}</span>
      <span className={s.grow} />
      {aside ? <span className={s.sectionAside}>{aside}</span> : null}
    </div>
    {children}
  </section>
);

export const Timeline = ({ items }: { items: readonly string[] }) => {
  const days = timelineDays(items, new Date());
  return (
    <Section title="Timeline">
      {days.length ? (
        <ol className={`${s.timeline} selectable`}>
          {days.map((day, i) => (
            <li key={`${i}-${day.key}`} className={s.timelineDay}>
              <time className={s.timelineDate} dateTime={day.key || undefined} title={day.key || undefined}>
                {day.label}
              </time>
              <ul className={s.timelineEntries}>
                {day.entries.map((entry, j) => (
                  <li key={`${j}-${entry}`} className={s.timelineEntry}>
                    {entry}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <span className={s.quiet}>Nothing in timeline.md yet.</span>
      )}
    </Section>
  );
};
