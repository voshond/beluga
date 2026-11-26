import type { OpenWith, Person } from '@beluga/core/initiatives/people.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { timelineDayLabel } from './initiatives-model.js';
import p from './people.module.css';

const NO_PEOPLE: readonly Person[] = [];

export const usePeople = (): readonly Person[] => useApp((st) => st.initiatives.people ?? NO_PEOPLE, sameDeep);

export const contactWords = (day: string | undefined, now: Date): string => (day ? `Last talked: ${timelineDayLabel(day, now)}` : 'No contact on the timeline yet');

type OpenListProps = {
  readonly title: string;
  readonly items: readonly OpenWith[];
  readonly showWhere?: boolean;
};

export const OpenList = ({ title, items, showWhere }: OpenListProps) => {
  if (!items.length) return null;
  return (
    <div className={p.open}>
      <span className={p.openTitle}>
        {title} · {items.length}
      </span>
      <ul className={p.openList} aria-label={title}>
        {items.map((item) => (
          <li key={`${item.initiative}:${item.suggestion ?? item.text}`}>
            {item.suggestion ? `#${item.suggestion} ` : ''}
            {item.text}
            {showWhere ? <span className={p.openWhere}> · {item.initiativeName}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
};

export const Handles = ({ person }: { person: Person | undefined }) => {
  if (!person || !(person.slack || person.jira)) return null;
  return (
    <>
      {person.slack ? <span>Slack: {person.slack}</span> : null}
      {person.jira ? <span>Jira: {person.jira}</span> : null}
    </>
  );
};
