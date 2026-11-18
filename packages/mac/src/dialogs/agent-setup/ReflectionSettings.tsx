import { useState } from 'react';
import { REFLECTION_MODEL_DEFAULT, REFLECTION_MODEL_MAX } from '@beluga/shared/settings-schema.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { Group, Row, Switch } from '../settings-controls.js';
import a from './agent-setup.module.css';

export const ReflectionSettings = () => {
  const api = useApi();
  const on = useApp((st) => st.prefs.reflection);
  const saved = useApp((st) => st.prefs.reflectionModel);
  const [model, setModel] = useState(saved);

  const handleToggle = (value: boolean) => void api.session.setPrefs({ reflection: value });

  const handleBlur = () => {
    const next = model.trim() || REFLECTION_MODEL_DEFAULT;
    setModel(next);
    if (next === saved) return;
    void api.session.setPrefs({ reflectionModel: next });
  };

  return (
    <Group title="Learn from your conversations">
      <Row
        label="Propose what to remember when work ends"
        detail="When a worktree merges, or when you pick Look Back on a chat, a small model reads that conversation once and proposes what your agents should remember. Each proposal waits in Needs You: nothing is kept until you say so. Uses your agent’s tokens."
      >
        <Switch label="Propose what to remember" on={on} onChange={handleToggle} />
      </Row>
      <Row label="Model" detail={`The model it runs on. ${REFLECTION_MODEL_DEFAULT} unless you pick another.`}>
        <input
          className={a.field}
          aria-label="Reflection model"
          spellCheck={false}
          disabled={!on}
          maxLength={REFLECTION_MODEL_MAX}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => e.key === 'Enter' && handleBlur()}
        />
      </Row>
    </Group>
  );
};
