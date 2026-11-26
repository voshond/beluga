import { useState } from 'react';
import { type EnrichProposal, NO_ENRICHMENT } from '@beluga/core/initiatives/enrichment.js';
import { type Person, type PersonAcross, peopleAcross } from '@beluga/core/initiatives/people.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty, IconButton } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import { EnrichFound } from './EnrichFound.js';
import { Handles, OpenList, PersonPicture, contactWords, usePeople } from './PeopleParts.js';
import { PersonSheet } from './PersonSheet.js';
import { useInitiativeActions } from './use-initiatives.js';
import home from '../sentinel/home.module.css';
import p from './people.module.css';
import s from './initiatives.module.css';

type CardProps = {
  readonly across: PersonAcross;
  readonly now: Date;
  readonly found: readonly EnrichProposal[];
  readonly looking: boolean;
  readonly onEdit: (person: Person) => void;
};

const PersonCard = ({ across, now, found, looking, onEdit }: CardProps) => {
  const a = useInitiativeActions();
  const { person } = across;
  const handleEdit = (): void => onEdit(person);
  const handleEnrich = (): void => void a.act(() => a.api.enrichPeople([person.slug]), `Looking up ${person.name}`);
  const handleRemove = (): void =>
    openSheet({
      kind: 'confirm',
      title: `Remove ${person.name} from the directory?`,
      message: across.roles.length ? 'Take them off their initiatives first.' : 'Their file in people/ goes; the initiatives’ history stays.',
      confirm: 'Remove',
      run: () => void a.act(() => a.api.removePerson(person.slug), `Removed ${person.name}`),
    });
  return (
    <div role="listitem" className={s.card} data-person={person.slug}>
      <span className={s.cardHead}>
        <PersonPicture slug={person.slug} name={person.name} size={20} />
        <span className={s.cardName}>{person.name}</span>
        {person.title ? <span className={p.role}>{person.title}</span> : null}
        <span className={s.grow} />
        <IconButton size="small" icon="sparkles" label={`Enrich ${person.name}`} disabled={looking} onClick={handleEnrich} />
        <IconButton size="small" icon="pencil" label={`Edit ${person.name}`} onClick={handleEdit} />
        <IconButton size="small" icon="trash" label={`Remove ${person.name}`} onClick={handleRemove} />
      </span>
      {across.roles.length ? (
        <span className={s.chips}>
          {across.roles.map((r) => (
            <span key={r.initiative} className={s.pill}>
              {r.initiativeName}
              {r.role ? `: ${r.role}` : ''}
            </span>
          ))}
        </span>
      ) : null}
      {person.cares ? <span className={p.cares}>Cares about: {person.cares}</span> : null}
      <span className={p.meta}>
        <span>{contactWords(across.lastContact, now)}</span>
        <Handles person={person} />
      </span>
      <OpenList title="Waiting on them" items={across.waitingOnThem} showWhere />
      <OpenList title="They wait on you" items={across.waitingOnYou} showWhere />
      <EnrichFound person={person} found={found} />
    </div>
  );
};

type Editing = { readonly person?: Person };

export const PeoplePage = () => {
  const a = useInitiativeActions();
  const enabled = useApp((st) => st.initiatives.enabled);
  const items = useApp((st) => st.initiatives.items, sameDeep);
  const people = usePeople();
  const enrichment = useApp((st) => st.initiatives.enrichment ?? NO_ENRICHMENT, sameDeep);
  const now = new Date(useClock(true, 60_000));
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const handleNew = (): void => setEditing({});
  const handleEdit = (person: Person): void => setEditing({ person });
  const handleClose = (): void => setEditing(undefined);
  const handleEnrichAll = (): void => void a.act(() => a.api.enrichPeople(undefined), 'Looking everyone up in Slack, Jira, Google and GitHub');
  if (!enabled) return <Empty icon="people" title="Initiatives need the Beluga app" detail="Open the Beluga app to see the people across them." />;
  const all = peopleAcross(people, items);
  return (
    <div className={home.home} data-initiative-people="">
      <div className={home.page}>
        <div className={s.wrap}>
          <div className={s.head}>
            <Icon name="people" size={18} />
            <h1 className={s.title}>People</h1>
            <span className={s.grow} />
            <Button size="small" variant="quiet" icon="back" onClick={a.openList}>
              All Initiatives
            </Button>
            <Button size="small" icon="sparkles" disabled={enrichment.running || !people.length} onClick={handleEnrichAll}>
              {enrichment.running ? 'Looking Them Up…' : 'Enrich People'}
            </Button>
            <Button variant="primary" icon="plus" onClick={handleNew}>
              New Person
            </Button>
          </div>
          <p className={s.lede}>Everyone across your initiatives, each kept once: their roles, what waits on them, what they wait on you for, and when you last talked.</p>
          {enrichment.running ? (
            <span className={s.quiet} role="status">
              Your agent is looking them up in Slack, Jira, the Google directory and GitHub. What it finds shows on each person to take or dismiss.
            </span>
          ) : null}
          {enrichment.error ? (
            <div className={s.trouble} role="alert">
              <Icon name="alert" size={13} />
              {enrichment.error}
            </div>
          ) : null}
          {all.length ? (
            <div className={s.list} role="list" aria-label="People">
              {all.map((across) => (
                <PersonCard key={across.person.slug} across={across} now={now} found={enrichment.proposals.filter((x) => x.person === across.person.slug)} looking={enrichment.running} onEdit={handleEdit} />
              ))}
            </div>
          ) : (
            <Empty icon="people" title="Nobody in the directory yet" detail="Add someone here, or on an initiative’s page: its agent can propose the people from its people.md." action={<Button icon="plus" onClick={handleNew}>New Person</Button>} />
          )}
        </div>
      </div>
      {editing ? <PersonSheet {...(editing.person ? { person: editing.person } : {})} close={handleClose} /> : null}
    </div>
  );
};
