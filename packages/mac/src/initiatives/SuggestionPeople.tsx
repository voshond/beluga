import type { Suggestion } from '@beluga/core/initiatives/model.js';
import { personName } from '@beluga/core/initiatives/people.js';
import { usePeople } from './PeopleParts.js';
import p from './people.module.css';
import s from './initiatives.module.css';

/** A suggestion's people: who it waits on, who waits on it, and the directory entries a people.md pass proposes. */
export const SuggestionPeople = ({ suggestion }: { suggestion: Suggestion }) => {
  const people = usePeople();
  const waitingOn = personName(people, suggestion.waitingOn);
  const askedBy = personName(people, suggestion.askedBy);
  const proposals = suggestion.people ?? [];
  if (!waitingOn && !askedBy && !proposals.length) return null;
  return (
    <>
      {waitingOn ? (
        <>
          <span className={s.recordLabel}>Waiting on</span>
          <div className={s.recordText}>{waitingOn}</div>
        </>
      ) : null}
      {askedBy ? (
        <>
          <span className={s.recordLabel}>They wait on you</span>
          <div className={s.recordText}>{askedBy}</div>
        </>
      ) : null}
      {proposals.length ? (
        <>
          <span className={s.recordLabel}>People · {proposals.length}</span>
          <ul className={`${s.recordText} ${p.proposals}`} aria-label="Proposed people">
            {proposals.map((x) => (
              <li key={x.name}>
                <strong>{x.name}</strong>
                {x.role ? `: ${x.role}` : ''}
                {x.cares ? <span className={p.openWhere}> · cares about {x.cares}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
};
