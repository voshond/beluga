import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { type LinkKind, type SourceContext, linkParts } from '@beluga/core/initiatives/log.js';
import { type InitiativeView, type TimelineEntry, type TimelineKind } from '@beluga/core/initiatives/model.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import { type ActivityCell, activityWeeks, activityWords, timelineDays } from './initiatives-model.js';
import { Section } from './InitiativeParts.js';
import s from './initiatives.module.css';

const FIRST = 8;

const WEEKS = 52;

const LABELS = 30;

const CELL = 12;

const GAP = 3;

const fittingWeeks = (width: number): number => Math.max(1, Math.min(WEEKS, Math.floor((width - LABELS + GAP) / (CELL + GAP))));

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''] as const;

const KIND: Readonly<Record<TimelineKind, { readonly icon?: IconName; readonly label: string }>> = {
  'check-in': { icon: 'check', label: 'Check-in' },
  decision: { icon: 'diamond', label: 'Decision' },
  message: { icon: 'send', label: 'Message' },
  ticket: { icon: 'issue', label: 'Ticket' },
  said: { icon: 'chat', label: 'Said' },
  doc: { icon: 'fileText', label: 'Doc' },
  meeting: { icon: 'calendar', label: 'Meeting' },
  artifact: { icon: 'clip', label: 'Artifact' },
  created: { icon: 'flag', label: 'Created' },
  update: { icon: 'bell', label: 'Update' },
  event: { label: '' },
};

const LINK_ICON: Readonly<Record<LinkKind, IconName | undefined>> = { ticket: undefined, doc: 'fileText', slack: 'chat', link: 'external' };

const EntryText = ({ text, item }: { text: string; item: SourceContext }) => (
  <span className={s.feedText}>
    {linkParts(text, item).map((part, i) => {
      if (!part.kind) return <span key={i}>{part.text}</span>;
      const url = part.url;
      const icon = LINK_ICON[part.kind];
      const handleOpen = (): void => {
        if (url) void openExternal(url);
      };
      return (
        <button key={i} type="button" className={s.feedLink} data-link={part.kind} onClick={handleOpen} disabled={!url} title={part.title ?? url} aria-label={url ? `Open ${part.title ?? part.text}` : part.text}>
          {icon ? <Icon name={icon} size={11} /> : null}
          {part.text}
        </button>
      );
    })}
  </span>
);

const Entry = ({ entry, item }: { entry: TimelineEntry; item: SourceContext }) => {
  const kind = KIND[entry.kind];
  return (
    <li className={s.feedEntry} data-kind={entry.kind}>
      <span className={s.feedIcon} aria-hidden>
        {kind.icon ? <Icon name={kind.icon} size={11} /> : <span className={s.feedDot} />}
      </span>
      <EntryText text={entry.text} item={item} />
      <span className={s.feedKind}>{kind.label}</span>
    </li>
  );
};

const ActivityGrid = ({ entries, picked, onPick }: { entries: readonly TimelineEntry[]; picked: string | undefined; onPick: (key: string) => void }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(WEEKS);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setCount(fittingWeeks(el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const now = new Date();
  const weeks = activityWeeks(entries, now, count);
  const cell = (c: ActivityCell) => {
    if (c.future) return <span key={c.key} className={s.gridCell} data-future />;
    const handleClick = (): void => onPick(c.key);
    const words = activityWords(c, now);
    return <button key={c.key} type="button" className={s.gridCell} data-level={c.level} data-picked={picked === c.key || undefined} onClick={handleClick} disabled={!c.count} title={words} aria-label={words} aria-pressed={picked === c.key} />;
  };
  return (
    <div ref={ref} className={s.grid} style={{ '--weeks': count, '--labels': `${LABELS}px`, '--gap': `${GAP}px` } as CSSProperties} role="group" aria-label="Activity by day">
      <div className={s.gridDays} aria-hidden>
        <span />
        {WEEKDAYS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week.cells[0]!.key} className={s.gridWeek}>
          <span className={s.gridMonth} aria-hidden>
            {week.month ?? ''}
          </span>
          {week.cells.map(cell)}
        </div>
      ))}
    </div>
  );
};

export const Timeline = ({ item }: { item: InitiativeView }) => {
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [all, setAll] = useState(false);
  const handlePick = (key: string): void => setPicked((was) => (was === key ? undefined : key));
  const handleClear = (): void => setPicked(undefined);
  const handleAll = (): void => setAll((was) => !was);
  const shown = picked ? item.timeline.filter((e) => e.day === picked) : all ? item.timeline : item.timeline.slice(0, FIRST);
  const days = timelineDays(shown, new Date());
  const more = !picked && item.timeline.length > FIRST;
  const aside = picked ? (
    <Button size="small" variant="quiet" icon="x" onClick={handleClear}>
      Show all days
    </Button>
  ) : null;
  if (!item.timeline.length) {
    return (
      <Section title="Timeline">
        <span className={s.quiet}>Nothing in timeline.md yet.</span>
      </Section>
    );
  }
  return (
    <>
      <Section title="Activity">
        <ActivityGrid entries={item.timeline} picked={picked} onPick={handlePick} />
      </Section>
      <Section title="Timeline" aside={aside}>
        <ol className={`${s.feed} selectable`}>
          {days.map((day, i) => (
            <li key={`${i}-${day.key}`} className={s.feedDay}>
              <time className={s.feedDate} dateTime={day.key || undefined} title={day.key || undefined}>
                {day.label}
              </time>
              <ul className={s.feedEntries}>
                {day.entries.map((entry, j) => (
                  <Entry key={`${j}-${entry.text}`} entry={entry} item={item} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
        {more ? (
          <Button size="small" variant="quiet" icon={all ? 'chevronUp' : 'chevronDown'} onClick={handleAll}>
            {all ? 'Show fewer' : `Show all ${item.timeline.length}`}
          </Button>
        ) : null}
      </Section>
    </>
  );
};
