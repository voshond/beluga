import { useState } from 'react';
import { EPIC_KEY, type InitiativeView } from '@beluga/core/initiatives/model.js';
import { Field, FormSheet, TextArea, TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { epicKeys, splitList } from './initiatives-model.js';
import { useInitiativeActions } from './use-initiatives.js';

type SheetProps = {
  readonly editing?: InitiativeView;
  readonly close: () => void;
};

export const NewInitiativeSheet = ({ editing, close }: SheetProps) => {
  const a = useInitiativeActions();
  const projectNames = useApp((st) => st.projects.filter((p) => p.root && !p.error).map((p) => p.name).join('\n'));
  const projects = projectNames ? projectNames.split('\n') : [];
  const [name, setName] = useState(editing?.name ?? '');
  const [goal, setGoal] = useState(editing?.goal ?? '');
  const [epics, setEpics] = useState(editing?.epics.join(', ') ?? '');
  const [slack, setSlack] = useState(editing?.slackChannels.join(', ') ?? '');
  const [docs, setDocs] = useState(editing?.docs.join('\n') ?? '');
  const [calendar, setCalendar] = useState(editing?.calendarMatch ?? '');
  const [repos, setRepos] = useState<readonly string[]>(editing?.repos ?? []);
  const badEpics = epicKeys(epics).filter((key) => !EPIC_KEY.test(key));
  const fields = { name: name.trim(), goal: goal.trim(), epics: epicKeys(epics), slackChannels: splitList(slack), docs: splitList(docs), calendarMatch: calendar.trim(), repos: [...repos] };

  const handlePickRepo = (repo: string): void => setRepos((was) => (was.includes(repo) ? was.filter((r) => r !== repo) : [...was, repo]));

  const handleSubmit = async (): Promise<string | void> => {
    if (badEpics.length) return `Not an epic key: ${badEpics.join(', ')}`;
    if (editing) {
      const saved = await a.update(editing.slug, fields);
      if (!saved) return 'Couldn’t save it: see the message above';
      return close();
    }
    const made = await a.create(fields);
    if (!made) return 'Couldn’t make it: see the message above';
    close();
    a.open({ slug: made.slug, chats: { chats: [], active: 'main' } });
  };

  return (
    <FormSheet
      title={editing ? `Edit ${editing.name}` : 'New Initiative'}
      icon="flag"
      intro={editing ? undefined : 'A place to drive one thing to ship: its epics, channels, meetings and decisions, with chats and a memory your agent keeps. Its check-in starts off.'}
      submitLabel={editing ? 'Save' : 'Make Initiative'}
      canSubmit={Boolean(name.trim())}
      width={600}
      onCancel={close}
      onSubmit={handleSubmit}
    >
      <Field label="Name" htmlFor="initiative-name">
        <TextInput id="initiative-name" value={name} onChange={setName} maxLength={120} placeholder="Checkout v2" data-autofocus />
      </Field>
      <Field label="Goal" htmlFor="initiative-goal" hint="What shipped looks like, in a sentence or two">
        <TextArea id="initiative-goal" value={goal} onChange={setGoal} rows={3} maxLength={4000} placeholder="Ship the one-page checkout to every market before the holiday freeze" />
      </Field>
      <Field label="Jira epics" htmlFor="initiative-epics" hint="Keys, separated by commas: progress comes from their tickets" error={badEpics.length ? `Not an epic key: ${badEpics.join(', ')}` : undefined}>
        <TextInput id="initiative-epics" value={epics} onChange={setEpics} placeholder="SHOP-120, SHOP-121" />
      </Field>
      <Field label="Slack channels" htmlFor="initiative-slack">
        <TextInput id="initiative-slack" value={slack} onChange={setSlack} placeholder="#checkout-v2" />
      </Field>
      <Field label="Docs" htmlFor="initiative-docs" hint="One link per line">
        <TextArea id="initiative-docs" value={docs} onChange={setDocs} rows={2} placeholder="https://docs.example.com/checkout-v2" />
      </Field>
      <Field label="Meetings" htmlFor="initiative-calendar" hint="Calendar events whose title has these words">
        <TextInput id="initiative-calendar" value={calendar} onChange={setCalendar} maxLength={200} placeholder="Checkout" />
      </Field>
      <Field label="Repos" hint={repos.length ? repos.join(', ') : 'Your projects where its code work happens'}>
        <PickMenu<string> label="Repos" multiple choices={projects.map((p) => ({ value: p, label: p, mark: <Icon name="folder" size={13} /> }))} chosen={repos} onPick={handlePickRepo}>
          <Button size="small" icon="plus" aria-label="Pick repos">
            {repos.length ? `${repos.length} linked` : 'Link Repos'}
          </Button>
        </PickMenu>
      </Field>
    </FormSheet>
  );
};
