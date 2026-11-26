import { type ChangeEvent, useState } from 'react';
import { type Audience, UPDATE_TIME, type UpdateTone } from '@beluga/core/initiatives/audience.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { DAY_NAMES } from '@beluga/core/sentinel/model.js';
import { Field, FormSheet, Popup, TextInput } from '../components/FormSheet.js';
import { WEEK } from '../sentinel/sentinel-model.js';
import { TargetFields, type TargetForm, targetFormOf, targetOfForm } from './AudienceTarget.js';
import { usePeople } from './PeopleParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import sentinel from '../sentinel/sentinel.module.css';
import u from './updates.module.css';

const TONE_OPTIONS: ReadonlyArray<{ readonly value: UpdateTone; readonly label: string }> = [
  { value: 'short', label: 'Short, for execs' },
  { value: 'detailed', label: 'Detailed, for the team' },
];

const toggled = (list: readonly number[], value: number): number[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value].sort((a, b) => a - b));

type AudienceSheetProps = {
  readonly item: InitiativeView;
  readonly audience?: Audience;
  readonly close: () => void;
};

export const AudienceSheet = ({ item, audience, close }: AudienceSheetProps) => {
  const a = useInitiativeActions();
  const directory = usePeople();
  const [name, setName] = useState(audience?.name ?? '');
  const [people, setPeople] = useState<readonly string[]>(audience?.people ?? []);
  const [tone, setTone] = useState<UpdateTone>(audience?.tone ?? 'detailed');
  const [days, setDays] = useState<readonly number[]>(audience?.cadence.days ?? [1]);
  const [at, setAt] = useState(audience?.cadence.at ?? '09:00');
  const [form, setForm] = useState<TargetForm>(targetFormOf(audience?.target, item));
  const target = targetOfForm(form);
  const members = item.people.map((m) => m.person);
  const choices = [...directory].sort((x, y) => Number(members.includes(y.slug)) - Number(members.includes(x.slug)) || x.name.localeCompare(y.name));

  const handleTime = (event: ChangeEvent<HTMLInputElement>): void => {
    if (UPDATE_TIME.test(event.target.value)) setAt(event.target.value);
  };
  const handlePerson = (slug: string): void => setPeople((was) => (was.includes(slug) ? was.filter((x) => x !== slug) : [...was, slug]));
  const handleDay = (day: number): void => setDays((was) => toggled(was, day));
  const handleSubmit = async (): Promise<string | void> => {
    if (!target) return 'Say where it goes first';
    const saved = await a.act(() => a.api.saveAudience(item.slug, { ...(audience ? { id: audience.id } : {}), name: name.trim(), people: [...people], tone, cadence: { days: [...days], at }, target }));
    if (!saved) return 'Couldn’t save it: see the message above';
    close();
  };

  return (
    <FormSheet
      title={audience ? `Edit ${audience.name}` : 'New Audience'}
      icon="send"
      intro="Your agent drafts its status update on this schedule, or when you ask. You send it; a prep sheet is never sent."
      submitLabel={audience ? 'Save' : 'Add Audience'}
      canSubmit={Boolean(name.trim() && target)}
      width={560}
      scrolls
      onCancel={close}
      onSubmit={handleSubmit}
    >
      <Field label="Name" htmlFor="audience-name">
        <TextInput id="audience-name" value={name} onChange={setName} maxLength={120} placeholder="Leadership" data-autofocus />
      </Field>
      <Field label="People" hint={directory.length ? 'From the people directory' : 'Nobody in the directory yet: add people under People first'}>
        <span className={u.chooser} role="group" aria-label="People in this audience">
          {choices.map((person) => (
            <button key={person.slug} type="button" className={sentinel.day} aria-pressed={people.includes(person.slug)} onClick={() => handlePerson(person.slug)}>
              {person.name}
            </button>
          ))}
        </span>
      </Field>
      <Field label="Tone" htmlFor="audience-tone">
        <Popup<UpdateTone> id="audience-tone" value={tone} options={TONE_OPTIONS} onChange={setTone} />
      </Field>
      <Field label="When" hint={days.length ? 'Drafted at the first check-in after this' : 'No days: drafted only when you ask'}>
        <span className={u.chooser}>
          <input type="time" className={sentinel.time} aria-label="Update time" value={at} onChange={handleTime} />
          <span className={sentinel.days} role="group" aria-label="Update days">
            {WEEK.map((day) => (
              <button key={day} type="button" className={sentinel.day} aria-pressed={days.includes(day)} onClick={() => handleDay(day)}>
                {DAY_NAMES[day]}
              </button>
            ))}
          </span>
        </span>
      </Field>
      <TargetFields item={item} form={form} onChange={setForm} />
    </FormSheet>
  );
};
