import { useState } from 'react';
import { REFLECTION_MODEL_DEFAULT, REFLECTION_MODEL_MAX, REFLECTION_SKILL_MODEL_DEFAULT } from '@beluga/shared/settings-schema.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { Group, Row, Switch } from '../settings-controls.js';
import a from './agent-setup.module.css';

export const ReflectionSettings = () => {
  const api = useApi();
  const on = useApp((st) => st.prefs.reflection);
  const saved = useApp((st) => st.prefs.reflectionModel);
  const [model, setModel] = useState(saved);
  const skillsOn = useApp((st) => st.prefs.reflectionSkills);
  const savedSkillModel = useApp((st) => st.prefs.reflectionSkillModel);
  const [skillModel, setSkillModel] = useState(savedSkillModel);

  const handleToggle = (value: boolean) => void api.session.setPrefs({ reflection: value });

  const handleBlur = () => {
    const next = model.trim() || REFLECTION_MODEL_DEFAULT;
    setModel(next);
    if (next === saved) return;
    void api.session.setPrefs({ reflectionModel: next });
  };

  const handleSkillsToggle = (value: boolean) => {
    if (!on) return;
    void api.session.setPrefs({ reflectionSkills: value });
  };

  const handleSkillModelBlur = () => {
    const next = skillModel.trim() || REFLECTION_SKILL_MODEL_DEFAULT;
    setSkillModel(next);
    if (next === savedSkillModel) return;
    void api.session.setPrefs({ reflectionSkillModel: next });
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
      <Row
        label="Also propose skills"
        detail="After long multi-step work, or work that used one of your shared skills, a second look reads the steps your agent ran and proposes at most one skill: a new one, or a fix to one that turned out wrong. It waits in Needs You like any skill proposal. A second call on a stronger model, so it costs more than the memory look; short or simple conversations never get it."
      >
        <Switch label="Also propose skills" on={on && skillsOn} onChange={handleSkillsToggle} />
      </Row>
      <Row label="Skill model" detail={`The model that drafts the skill. ${REFLECTION_SKILL_MODEL_DEFAULT} unless you pick another: a thin skill is worse than none.`}>
        <input
          className={a.field}
          aria-label="Skill draft model"
          spellCheck={false}
          disabled={!on || !skillsOn}
          maxLength={REFLECTION_MODEL_MAX}
          value={skillModel}
          onChange={(e) => setSkillModel(e.target.value)}
          onBlur={handleSkillModelBlur}
          onKeyDown={(e) => e.key === 'Enter' && handleSkillModelBlur()}
        />
      </Row>
    </Group>
  );
};
