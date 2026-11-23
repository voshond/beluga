import { EFFORTS, type Effort } from '@beluga/shared/settings-schema.js';
import { agentForChoice, choiceForAgent } from '@beluga/ui/agent-choice.js';
import { pickName } from '@beluga/core/build-with.js';
import { YOUR_AGENT, useAgentEntries } from '../components/agent-options.js';
import { EFFORT_INFO, modelInfo } from '../chat/ModelPicker.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Select } from './settings-controls.js';

const AUTO = '';

/**
 * Settings › Agent › Plans (BLG-982): who builds what you plan once you approve it, and how hard it
 * thinks. Plan with a bigger model, build with a smaller one: Plan First, Plan with Tasks and new
 * plans start from it, and Builder ▸ in the mode menu changes it for one chat.
 */
export function BuildWithSettings() {
  const api = useApi();
  const builder = useApp((st) => st.prefs.buildWith);
  const runtimes = useApp((st) => st.runtimes);
  const models = useApp((st) => st.models);
  const entries = useAgentEntries();
  const options = entries.map((e) => ('section' in e ? e : { value: YOUR_AGENT, label: 'The agent that plans it', description: 'It plans and builds' }));
  const allowed = new Set<string>(builder ? (modelInfo({ runtimes, models }, builder.runtime, builder.model ?? '')?.efforts ?? EFFORTS) : EFFORTS);
  const handleAgent = (value: string): void => {
    if (value === YOUR_AGENT) return void api.session.setPrefs({ buildWith: null });
    const agent = agentForChoice(value, runtimes);
    const effort = builder?.effort && new Set<string>(modelInfo({ runtimes, models }, agent.runtime, agent.model ?? '')?.efforts ?? EFFORTS).has(builder.effort) ? builder.effort : undefined;
    void api.session.setPrefs({ buildWith: { ...agent, ...(effort ? { effort } : {}) } });
  };
  const handleEffort = (value: string): void => {
    if (!builder) return;
    const { effort: _, ...auto } = builder;
    void api.session.setPrefs({ buildWith: value === AUTO ? auto : { ...builder, effort: value as Effort } });
  };
  return (
    <Group title="Plans">
      <Row label="Build plans with" detail={builder ? `Once you approve a plan, ${pickName(builder)} builds it; the agent you planned with stops there. Builder in the mode menu changes it for one chat.` : 'The agent you plan with builds the plan too. Pick a smaller model to do the building once you approve.'}>
        <Select label="Build plans with" value={builder ? choiceForAgent(builder) : YOUR_AGENT} onChange={handleAgent} options={options} />
      </Row>
      {builder ? (
        <Row label="Builder effort" detail={allowed.size < EFFORTS.length ? 'Only the levels this model takes.' : undefined}>
          <Select
            label="Builder effort"
            value={builder.effort ?? AUTO}
            onChange={handleEffort}
            options={[{ value: AUTO, label: 'Auto', description: 'It decides, case by case' }, ...EFFORTS.map((e) => ({ value: e, label: EFFORT_INFO[e].label, description: EFFORT_INFO[e].detail, ...(allowed.has(e) ? {} : { disabled: true }) }))]}
          />
        </Row>
      ) : null}
    </Group>
  );
}
