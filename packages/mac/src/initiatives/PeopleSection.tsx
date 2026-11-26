import { useState } from 'react';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { type Member, type Person, lastContact, membersOf, needsPeoplePass, waitingOnThem, waitingOnYou } from '@beluga/core/initiatives/people.js';
import { Icon } from '../components/Icon.js';
import { Button, IconButton } from '../components/ui.js';
import { useClock } from '../lib/window-active.js';
import { openSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { Section } from './InitiativeParts.js';
import { Handles, OpenList, contactWords, usePeople } from './PeopleParts.js';
import { PersonSheet } from './PersonSheet.js';
import { useInitiativeActions } from './use-initiatives.js';
import p from './people.module.css';
import s from './initiatives.module.css';

type Editing = { readonly person?: Person; readonly legacy?: { readonly slug: string; readonly name: string }; readonly role?: string };

type RowProps = {
  readonly item: InitiativeView;
  readonly member: Member;
  readonly now: Date;
  readonly onEdit: (editing: Editing) => void;
};

const MemberRow = ({ item, member, now, onEdit }: RowProps) => {
  const a = useInitiativeActions();
  const who = member.person ?? { slug: member.slug, name: member.name, slack: '', jira: '' };
  const theyOwe = waitingOnThem(item, who);
  const youOwe = waitingOnYou(item, who);
  const handleEdit = (): void => onEdit({ ...(member.person ? { person: member.person } : { legacy: { slug: member.slug, name: member.name } }), ...(member.role ? { role: member.role } : {}) });
  const handleRemove = (): void =>
    openSheet({
      kind: 'confirm',
      title: `Take ${member.name} off ${item.name}?`,
      message: 'They stay in the people directory for the other initiatives.',
      confirm: 'Take Off',
      run: () => void a.act(() => a.api.setPerson(item.slug, member.slug, null)),
    });
  return (
    <div role="listitem" className={p.person} data-person={member.slug}>
      <span className={p.personHead}>
        <Icon name="person" size={13} />
        <span className={p.personName}>{member.name}</span>
        {member.role ? <span className={p.role}>{member.role}</span> : null}
        {member.person ? null : <span className={s.pill}>Not in the directory</span>}
        <span className={s.grow} />
        <IconButton size="small" icon="pencil" label={`Edit ${member.name}`} onClick={handleEdit} />
        <IconButton size="small" icon="x" label={`Take ${member.name} off`} onClick={handleRemove} />
      </span>
      <span className={p.meta}>
        <span>{contactWords(lastContact(item.timeline, who), now)}</span>
        <Handles person={member.person} />
      </span>
      <OpenList title="Waiting on them" items={theyOwe} />
      <OpenList title="They wait on you" items={youOwe} />
    </div>
  );
};

export const PeopleSection = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const people = usePeople();
  const now = new Date(useClock(true, 60_000));
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const members = membersOf(item, people);
  const others = people.filter((person) => !members.some((m) => m.slug === person.slug));
  const handleClose = (): void => setEditing(undefined);
  const handleNew = (): void => setEditing({});
  const handlePick = (slug: string): void => {
    const person = people.find((x) => x.slug === slug);
    if (person) setEditing({ person });
  };
  const handlePass = (): void => void a.act(() => a.api.proposePeople(item.slug), 'Reading people.md: its suggestion shows here');
  const aside = (
    <>
      {needsPeoplePass(item) ? (
        <Button size="small" icon="wand" onClick={handlePass} aria-label="Propose people from people.md">
          From people.md
        </Button>
      ) : null}
      <PickMenu<string> label="Add a person" choices={others.map((x) => ({ value: x.slug, label: x.name, mark: <Icon name="person" size={13} /> }))} chosen={[]} onPick={handlePick} actions={[{ label: 'New Person…', icon: 'plus', onSelect: handleNew }]} align="end">
        <IconButton size="small" icon="plus" label="Add a person" />
      </PickMenu>
    </>
  );
  return (
    <Section title="People" aside={aside}>
      {members.length ? (
        <div className={p.people} role="list" aria-label="People on this initiative">
          {members.map((member) => (
            <MemberRow key={member.slug} item={item} member={member} now={now} onEdit={setEditing} />
          ))}
        </div>
      ) : (
        <span className={s.quiet} role="status">
          Nobody yet. Add people from the directory, or let your agent propose them from people.md.
        </span>
      )}
      {editing ? <PersonSheet {...(editing.person ? { person: editing.person } : {})} {...(editing.legacy ? { legacy: editing.legacy } : {})} initiative={{ slug: item.slug, name: item.name, ...(editing.role ? { role: editing.role } : {}) }} close={handleClose} /> : null}
    </Section>
  );
};
