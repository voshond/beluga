import type { AudienceTarget } from '@beluga/core/initiatives/audience.js';
import { type InitiativeView, confluencePageIdOf } from '@beluga/core/initiatives/model.js';
import { slackTargetOf } from '@beluga/core/initiatives/updates.js';
import { Field, Popup, TextInput } from '../components/FormSheet.js';

export type TargetKind = AudienceTarget['kind'];

/** What the sheet's Where fields hold, as typed. */
export type TargetForm = {
  readonly kind: TargetKind;
  readonly where: string;
  readonly section: string;
  readonly meeting: string;
  readonly label: string;
};

const KIND_OPTIONS: ReadonlyArray<{ readonly value: TargetKind; readonly label: string }> = [
  { value: 'slack', label: 'Slack channel or thread' },
  { value: 'confluence', label: 'Confluence page section' },
  { value: 'prep', label: 'Prep sheet for a meeting' },
];

export const targetFormOf = (target: AudienceTarget | undefined, item: Pick<InitiativeView, 'meetings'>): TargetForm => {
  const blank: TargetForm = { kind: 'slack', where: '', section: '', meeting: item.meetings[0]?.match ?? '', label: target?.label ?? '' };
  if (!target) return blank;
  if (target.kind === 'slack') return { ...blank, kind: 'slack', where: target.thread ? `${target.channel} ${target.thread}` : target.channel };
  if (target.kind === 'confluence') return { ...blank, kind: 'confluence', where: target.page, section: target.section };
  return { ...blank, kind: 'prep', meeting: target.meeting };
};

const pageIdOf = (where: string): string | undefined => confluencePageIdOf(where) ?? /^\d{1,20}$/.exec(where.trim())?.[0];

/** The target the form describes, or none while it is not complete. */
export const targetOfForm = (form: TargetForm): AudienceTarget | undefined => {
  const label = form.label.trim() ? { label: form.label.trim() } : {};
  if (form.kind === 'slack') {
    const [channel, thread] = form.where.trim().split(/\s+/);
    if (!channel) return undefined;
    const parsed = slackTargetOf(channel, form.label);
    return thread && !parsed.thread ? { ...parsed, thread } : parsed;
  }
  if (form.kind === 'confluence') {
    const page = pageIdOf(form.where);
    return page && form.section.trim() ? { kind: 'confluence', page, section: form.section.trim(), ...label } : undefined;
  }
  return form.meeting.trim() ? { kind: 'prep', meeting: form.meeting.trim(), ...label } : undefined;
};

type FieldsProps = {
  readonly item: Pick<InitiativeView, 'meetings'>;
  readonly form: TargetForm;
  readonly onChange: (form: TargetForm) => void;
};

export const TargetFields = ({ item, form, onChange }: FieldsProps) => {
  const set =
    <K extends keyof TargetForm>(key: K) =>
    (value: TargetForm[K]): void =>
      onChange({ ...form, [key]: value });
  const meetings = item.meetings.map((m) => ({ value: m.match, label: m.label ? `${m.label} (${m.match})` : m.match }));
  return (
    <>
      <Field label="Where it goes" htmlFor="audience-kind">
        <Popup<TargetKind> id="audience-kind" value={form.kind} options={KIND_OPTIONS} onChange={set('kind')} />
      </Field>
      {form.kind === 'slack' ? (
        <Field label="Channel or thread" htmlFor="audience-where" hint="A channel id, #name or a message link (its thread)">
          <TextInput id="audience-where" value={form.where} onChange={set('where')} maxLength={500} placeholder="#leadership" />
        </Field>
      ) : null}
      {form.kind === 'confluence' ? (
        <>
          <Field label="Page" htmlFor="audience-where" hint="Its link or page id: the update replaces one section">
            <TextInput id="audience-where" value={form.where} onChange={set('where')} maxLength={500} placeholder="https://acme.atlassian.net/wiki/spaces/X/pages/2201" />
          </Field>
          <Field label="Section heading" htmlFor="audience-section">
            <TextInput id="audience-section" value={form.section} onChange={set('section')} maxLength={200} placeholder="Status" />
          </Field>
        </>
      ) : null}
      {form.kind === 'prep' ? (
        <Field label="Meeting" htmlFor="audience-meeting" hint={meetings.length ? 'A meeting this initiative follows; the sheet is never sent' : 'Follow a meeting first: Edit… › Meetings'}>
          {meetings.length ? <Popup<string> id="audience-meeting" value={form.meeting} options={meetings} onChange={set('meeting')} /> : <span />}
        </Field>
      ) : null}
      <Field label="Label" htmlFor="audience-label">
        <TextInput id="audience-label" value={form.label} onChange={set('label')} maxLength={200} placeholder="Optional" />
      </Field>
    </>
  );
};
