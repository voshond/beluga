import { useState } from 'react';
import { watchPlaceOf } from '@beluga/core/initiatives/watches.js';
import { Field, FormSheet, TextInput } from '../components/FormSheet.js';
import { useInitiativeActions } from './use-initiatives.js';

type SheetProps = {
  readonly slug: string;
  readonly close: () => void;
};

/** Watch for an Answer…: what it waits for, where to look and who on; the agent looks by itself from then on. */
export const WatchSheet = ({ slug, close }: SheetProps) => {
  const a = useInitiativeActions();
  const [what, setWhat] = useState('');
  const [where, setWhere] = useState('');
  const [label, setLabel] = useState('');
  const [who, setWho] = useState('');
  const place = watchPlaceOf(where, label);
  const handleSubmit = async (): Promise<string | void> => {
    if (!place) return 'Say where to look';
    const made = await a.act(() => a.api.addWatch(slug, { what: what.trim(), where: place, ...(who.trim() ? { waitingOn: who.trim() } : {}) }), 'Watching for an answer');
    if (!made) return 'Couldn’t add it: see the message above';
    close();
  };
  return (
    <FormSheet
      title="Watch for an Answer"
      icon="eye"
      intro="Your agent looks there by itself between check-ins (hourly the first day, then less often) and tells you when something new comes in."
      submitLabel="Watch"
      canSubmit={Boolean(what.trim() && place)}
      onCancel={close}
      onSubmit={handleSubmit}
    >
      <Field label="What it waits for" htmlFor="watch-what">
        <TextInput id="watch-what" value={what} onChange={setWhat} maxLength={500} placeholder="Julia’s go-ahead on the launch date" data-autofocus />
      </Field>
      <Field label="Where to look" htmlFor="watch-where" hint="A Slack thread’s link, a Jira key, a pull request or a doc’s link">
        <TextInput id="watch-where" value={where} onChange={setWhere} maxLength={500} placeholder="SHOP-123 or a link" />
      </Field>
      <Field label="Its name" htmlFor="watch-label" hint="Optional: how the page names that place">
        <TextInput id="watch-label" value={label} onChange={setLabel} maxLength={200} placeholder="#checkout-v2 thread" />
      </Field>
      <Field label="Waiting on" htmlFor="watch-who" hint="Optional">
        <TextInput id="watch-who" value={who} onChange={setWho} maxLength={120} placeholder="Julia" />
      </Field>
    </FormSheet>
  );
};
