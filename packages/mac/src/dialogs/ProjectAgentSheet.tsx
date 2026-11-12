import { useState } from 'react';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { agentChoices, agentForChoice, choiceForAgent } from '@beluga/ui/agent-choice.js';
import { agentEntries } from '../chat/ModelPicker.js';
import { Field, FormSheet, Popup } from '../components/FormSheet.js';
import { agentName, useMyAgent } from '../lib/agent-words.js';
import { useApi, useApp } from '../lib/beluga.js';

const SAME_AS_YOURS = '~';

export function ProjectAgentSheet({ projectId, close }: { projectId: string; close: () => void }) {
  const api = useApi();
  const name = useApp((st) => st.projects.find((p) => p.id === projectId)?.name);
  const projectAgents = useApp((st) => st.prefs.projectAgents);
  const models = useApp((st) => st.models);
  const runtimes = useApp((st) => st.runtimes);
  const mine = useMyAgent();
  const saved = name && projectAgents?.[name] ? choiceForAgent(projectAgents[name]) : SAME_AS_YOURS;
  const [agent, setAgent] = useState(saved);
  if (!name) return null;

  const handleSave = (): void => {
    const { [name]: _, ...others } = projectAgents ?? {};
    void api.session.setPrefs({ projectAgents: agent === SAME_AS_YOURS ? others : { ...others, [name]: agentForChoice(agent, runtimes) } });
    close();
  };

  const options = [{ value: SAME_AS_YOURS, label: `Same as yours (${agentName(mine)})`, icon: agentMark(mine) }, ...agentEntries(agentChoices(runtimes, models, agent === SAME_AS_YOURS ? [] : [agentForChoice(agent).model ?? '']))];

  return (
    <FormSheet title={`Agent for ${name}`} icon="bot" intro="Runs this project's new worktrees and conversations, and answers when friends write @you about it. A worktree can still pick another." submitLabel="Save" canSubmit={agent !== saved} onSubmit={handleSave} onCancel={close} width={520}>
      <Field label="Agent" htmlFor="project-agent">
        <Popup id="project-agent" value={agent} onChange={setAgent} options={options} />
      </Field>
    </FormSheet>
  );
}
