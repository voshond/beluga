import { useEffect, useState } from 'react';
import { runtimeMark } from '@beluga/shared/agent-marks.js';
import { agentPicker } from '@beluga/shared/agent-picker.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { autoChoice, foreignMark, myRuntime, pickerState, samePicker, setMyAgent } from '../../chat/ModelPicker.js';
import { Field, FormSheet, PickList, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { useMyAgentName } from '../../lib/agent-words.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';
import { revealLabel, thisComputer } from '../../lib/os-words.js';

/**
 * The model for one conversation (or for new ones): the models of the agent it runs on, the
 * current one selected, each with its mark. Another agent is picked in the composer's agent picker.
 */
export function ModelSheet({ menu, close }: NativeMenuProps<'model'>) {
  const api = useApi();
  const picker = useApp((st) => agentPicker(pickerState(st), menu.channel ?? 'draft', myRuntime(st.prefs), undefined, menu.channel ? autoChoice(st, menu.channel) : undefined), samePicker);
  const group = picker.groups.find((g) => g.current);
  const models = group?.models ?? [];
  const current = models.find((m) => m.on)?.value ?? picker.model;
  const [value, setValue] = useState(current);
  const use = (v: string): void => {
    if (!group || models.find((m) => m.value === v)?.why) return;
    if (menu.channel === undefined) setMyAgent(api, group.runtime, group.label, v);
    else void api.workbench.setModel(menu.channel, v);
    close();
  };
  const who = group?.label ?? 'Your agent';
  return (
    <FormSheet
      title={menu.channel === undefined ? 'Model for New Conversations' : 'Model for This Conversation'}
      icon={runtimeMark(picker.runtime)}
      intro={`${who} runs ${menu.channel === undefined ? 'new conversations' : 'this conversation'}. Each conversation can use its own model; it applies from the next message.`}
      submitLabel="Use This Model"
      canSubmit={value !== current && !models.find((m) => m.value === value)?.why}
      onSubmit={() => use(value)}
      onCancel={close}
      width={500}
    >
      <PickList
        label={`${who} models`}
        value={value}
        onChange={setValue}
        onChoose={use}
        rows={models.map((m) => ({
          value: m.value,
          leading: <Icon name={foreignMark(m.value, picker.runtime) ?? runtimeMark(picker.runtime)} size={13} />,
          name: m.label,
          detail: m.why ?? m.description,
          trailing: m.value === current ? <Icon name="check" size={13} /> : undefined,
        }))}
      />
    </FormSheet>
  );
}

/** First thing after joining a room: may people here use your agent? */
export function WelcomeSheet({ menu, close }: NativeMenuProps<'welcome'>) {
  const pick = usePick(menu);
  const agent = useMyAgentName();
  const room = useApp((st) => st.room);
  const self = useApp((st) => st.self?.name);
  const peers = useApp((st) => st.peers);
  const others = peers.filter((p) => p.name !== self).map((p) => p.name);
  const [policy, setPolicy] = useState<'share-ask' | 'share-auto' | 'share-deny'>('share-ask');
  return (
    <FormSheet
      title={`Welcome to ${room}`}
      icon="people"
      intro={
        <>
          <p>{others.length ? `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} here.` : 'Nobody else is here yet.'}</p>
          <p>Friends can ask your {agent} for help. It runs on {thisComputer()}, on your own account, only in folders you share, and you always see what they ask.</p>
        </>
      }
      submitLabel="Continue"
      onSubmit={() => void pick(policy)}
      onCancel={close}
      cancelLabel="Later"
      width={520}
    >
      <Field label="Your agent">
        <PickList
          label="Can people in this room use your agent?"
          value={policy}
          onChange={setPolicy}
          onChoose={(v) => pick(v)}
          rows={[
            { value: 'share-ask', name: 'Ask me each time', detail: 'Recommended: you approve every request' },
            { value: 'share-auto', name: 'Everyone can use it', detail: 'Requests run without asking' },
            { value: 'share-deny', name: 'Keep it private', detail: 'Only you can use your agent' },
          ]}
        />
      </Field>
    </FormSheet>
  );
}

/** The inbox is the notification centre here (the bell). */
export function InboxRedirect({ close }: NativeMenuProps<'inbox'>) {
  const { ui } = useBeluga();
  useEffect(() => {
    close();
    ui.patch({ notices: true });
  }, []);
  return null;
}

/** An archived workspace: restore it (the usual thing), read it, or delete it for good. */
export function ArchivedSheet({ menu, close }: NativeMenuProps<'archived'>) {
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  if (!ws) return null;
  const worktree = ws.kind === 'worktree';
  return (
    <FormSheet
      title={`“${ws.name}” is archived`}
      icon="archive"
      intro={worktree ? <>Its branch <code>{ws.branch ?? ''}</code> and conversation are kept. Restoring makes the worktree again from the branch.</> : 'Its conversation is kept. Restoring shows it in the sidebar again.'}
      submitLabel="Restore"
      onSubmit={() => void pick('a-restore')}
      onCancel={close}
      width={580}
      footer={
        <>
          <button type="button" className={f.linkButton} onClick={() => pick('a-open')}>
            Read Conversation
          </button>
          <button type="button" className={f.linkButton} onClick={() => pick('a-finder')}>
            {revealLabel('Project')}
          </button>
          <button type="button" className={f.linkDanger} onClick={() => pick('a-delete')}>
            Delete…
          </button>
        </>
      }
    />
  );
}
