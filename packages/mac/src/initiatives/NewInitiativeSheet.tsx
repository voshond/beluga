import { useState } from 'react';
import { EPIC_KEY, GOAL_MAX, type InitiativeView } from '@beluga/core/initiatives/model.js';
import { Field, FormSheet, TextArea, TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { GoalDraft, RefineButton, useGoalRefine } from './GoalRefine.js';
import { type RefRow, docEntries, docRows, epicKeys, meetingEntries, meetingRows, slackEntries, slackRows } from './initiatives-model.js';
import { RefList } from './RefList.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

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
  const [slack, setSlack] = useState<readonly RefRow[]>(() => slackRows(editing?.slack ?? []));
  const [docs, setDocs] = useState<readonly RefRow[]>(() => docRows(editing?.docs ?? []));
  const [meetings, setMeetings] = useState<readonly RefRow[]>(() => meetingRows(editing?.meetings ?? []));
  const [repos, setRepos] = useState<readonly string[]>(editing?.repos ?? []);
  const badEpics = epicKeys(epics).filter((key) => !EPIC_KEY.test(key));
  const fields = { name: name.trim(), goal: goal.trim(), epics: epicKeys(epics), slack: slackEntries(slack), docs: docEntries(docs), meetings: meetingEntries(meetings), repos: [...repos] };
  const goodEpics = fields.epics.filter((key) => EPIC_KEY.test(key));
  const refine = useGoalRefine({ name: fields.name, goal: fields.goal, epics: goodEpics, docs: fields.docs });
  const canRefine = Boolean(fields.name || fields.goal || goodEpics.length || fields.docs.length);

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
      <Field label="Goal" htmlFor="initiative-goal" hint="What shipped looks like. Markdown works; your agent can shape it from a few words and the epic.">
        <div className={s.stack}>
          <TextArea id="initiative-goal" value={goal} onChange={setGoal} rows={goal.length > 300 ? 9 : 3} maxLength={GOAL_MAX} placeholder="Ship the one-page checkout to every market before the holiday freeze" />
          <div>
            <RefineButton refine={refine} disabled={!canRefine} />
          </div>
          <GoalDraft refine={refine} onUse={setGoal} />
        </div>
      </Field>
      <Field label="Jira epics" htmlFor="initiative-epics" hint="Keys, separated by commas: progress comes from their tickets" error={badEpics.length ? `Not an epic key: ${badEpics.join(', ')}` : undefined}>
        <TextInput id="initiative-epics" value={epics} onChange={setEpics} placeholder="SHOP-120, SHOP-121" />
      </Field>
      <Field label="Slack" hint="A #channel, or the link of a thread or a DM. Paste several links at once for a row each.">
        <RefList name="Slack conversation" rows={slack} onChange={setSlack} placeholder="#checkout-v2 or a Slack link" addLabel="Add Conversation" />
      </Field>
      <Field label="Docs" hint="A Confluence page, a Google Doc, Sheet or Slides, or any link. The check-in reads each and notes what changed.">
        <RefList name="Doc" rows={docs} onChange={setDocs} placeholder="A Confluence or Google Docs link" addLabel="Add Doc" max={50} />
      </Field>
      <Field label="Meetings" hint="Words a meeting’s title has, or one event’s link (a recurring one counts as a whole)">
        <RefList name="Meeting" rows={meetings} onChange={setMeetings} placeholder="Checkout sync, or an event link" addLabel="Add Meeting" />
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
