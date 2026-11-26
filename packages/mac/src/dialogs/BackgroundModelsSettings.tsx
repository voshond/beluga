import type { RuntimeModel } from '@beluga/shared/agent-runtimes.js';
import { modelName } from '@beluga/shared/agent-label.js';
import { INITIATIVE_MODEL_DEFAULT, SENTINEL_MODEL_DEFAULT } from '@beluga/shared/settings-schema.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Select } from './settings-controls.js';

type ModelOption = { readonly value: string; readonly label: string; readonly description?: string };

/** Claude's models as a pop-up's options: your agent's own model first, the default marked, and a model set by hand kept. */
const modelOptions = (models: readonly RuntimeModel[], saved: string, fallback: string): ModelOption[] => {
  const listed = models.filter((m) => m.value);
  const kept: readonly ModelOption[] = !saved || listed.some((m) => m.value === saved) ? [] : [{ value: saved, label: modelName(saved) }];
  return [
    { value: '', label: 'Your agent’s model', description: 'The model every conversation uses' },
    ...[...listed, ...kept].map((m) => ({ value: m.value, label: m.value === fallback ? `${m.label} (default)` : m.label, ...(m.description ? { description: m.description } : {}) })),
  ];
};

/**
 * Settings › Agent › Background models: what work Beluga starts on its own runs on when your agent
 * is Claude. An initiative's Check-in and Follow-ups chats, and a sentinel's agent step that picked
 * no agent of its own. A chat or step that picked a model keeps it.
 */
export function BackgroundModelsSettings() {
  const api = useApi();
  const models = useApp((st) => st.models);
  const initiativeModel = useApp((st) => st.prefs.initiativeModel);
  const sentinelModel = useApp((st) => st.prefs.sentinelModel);

  const handleInitiativeChange = (value: string) => void api.session.setPrefs({ initiativeModel: value });

  const handleSentinelChange = (value: string) => void api.session.setPrefs({ sentinelModel: value });

  return (
    <Group title="Background models">
      <Row label="Initiative check-ins and follow-ups" detail="The Check-in and Follow-ups chats an initiative runs on its own. A chat where you pick a model keeps its own; your other initiative chats use your agent’s model.">
        <Select label="Initiative check-ins and follow-ups" value={initiativeModel} onChange={handleInitiativeChange} options={modelOptions(models, initiativeModel, INITIATIVE_MODEL_DEFAULT)} />
      </Row>
      <Row label="Sentinel agent steps" detail="A sentinel’s agent step that picked no agent of its own. Each run shows the model it used.">
        <Select label="Sentinel agent steps" value={sentinelModel} onChange={handleSentinelChange} options={modelOptions(models, sentinelModel, SENTINEL_MODEL_DEFAULT)} />
      </Row>
    </Group>
  );
}
