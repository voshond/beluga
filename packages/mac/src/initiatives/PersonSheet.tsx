import { useState } from 'react';
import type { Person } from '@beluga/core/initiatives/people.js';
import { Field, FormSheet, TextArea, TextInput } from '../components/FormSheet.js';
import { useInitiativeActions } from './use-initiatives.js';

type PersonSheetProps = {
  readonly person?: Person;
  /** Someone on an initiative from before the directory: their entry is made under this slug and name. */
  readonly legacy?: { readonly slug: string; readonly name: string };
  /** The initiative whose role this sets; none edits the directory entry alone. */
  readonly initiative?: { readonly slug: string; readonly name: string; readonly role?: string };
  readonly close: () => void;
};

export const PersonSheet = ({ person, legacy, initiative, close }: PersonSheetProps) => {
  const a = useInitiativeActions();
  const [name, setName] = useState(person?.name ?? legacy?.name ?? '');
  const [role, setRole] = useState(initiative?.role ?? '');
  const [cares, setCares] = useState(person?.cares ?? '');
  const [slack, setSlack] = useState(person?.slack ?? '');
  const [jira, setJira] = useState(person?.jira ?? '');
  const [notes, setNotes] = useState(person?.notes ?? '');

  const slug = person?.slug ?? legacy?.slug;

  const handleSubmit = async (): Promise<string | void> => {
    const saved = await a.act(() => a.api.savePerson({ ...(slug ? { slug } : {}), name: name.trim(), cares, slack, jira, notes }));
    if (!saved) return 'Couldn’t save them: see the message above';
    if (initiative) {
      const placed = await a.act(() => a.api.setPerson(initiative.slug, saved.slug, role.trim()));
      if (!placed) return 'Saved in the directory, but the role didn’t save: see the message above';
    }
    close();
  };

  return (
    <FormSheet
      title={person ? `Edit ${person.name}` : 'New Person'}
      icon="person"
      intro="Kept once in the people directory and shared by every initiative."
      submitLabel={person ? 'Save' : 'Add Person'}
      canSubmit={Boolean(name.trim())}
      width={520}
      onCancel={close}
      onSubmit={handleSubmit}
    >
      <Field label="Name" htmlFor="person-name">
        <TextInput id="person-name" value={name} onChange={setName} maxLength={120} placeholder="Julia Barebysheva" data-autofocus={person ? undefined : true} />
      </Field>
      {initiative ? (
        <Field label={`Role in ${initiative.name}`} htmlFor="person-role">
          <TextInput id="person-role" value={role} onChange={setRole} maxLength={200} placeholder="Ops lead, signs off the rollout" data-autofocus={person ? true : undefined} />
        </Field>
      ) : null}
      <Field label="Cares about" htmlFor="person-cares">
        <TextArea id="person-cares" value={cares} onChange={setCares} rows={2} maxLength={2000} placeholder="Supplier lead times, no extra steps for Ops" />
      </Field>
      <Field label="Slack" htmlFor="person-slack">
        <TextInput id="person-slack" value={slack} onChange={setSlack} maxLength={120} placeholder="@julia or a DM id" />
      </Field>
      <Field label="Jira" htmlFor="person-jira">
        <TextInput id="person-jira" value={jira} onChange={setJira} maxLength={120} placeholder="Their Jira name" />
      </Field>
      <Field label="Notes" htmlFor="person-notes">
        <TextArea id="person-notes" value={notes} onChange={setNotes} rows={3} maxLength={4000} />
      </Field>
    </FormSheet>
  );
};
