import { useState } from 'react';
import { MACHINE_NOTE_MAX } from '@beluga/shared/agent-setup.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { Group, Row, Switch } from '../settings-controls.js';
import a from './agent-setup.module.css';

const PLACEHOLDER = 'This computer has the repos checked out and SSH keys to the NAS (nas.local). In projects that deploy there, you may use them to check results and deploy.';

export const MachineNoteSettings = () => {
  const api = useApi();
  const saved = useApp((st) => st.prefs.machineNote);
  const on = useApp((st) => st.prefs.machineNoteOn);
  const [text, setText] = useState(saved);

  const handleToggle = (value: boolean) => void api.session.setPrefs({ machineNoteOn: value });

  const handleBlur = () => {
    if (text === saved) return;
    void api.session.setPrefs({ machineNote: text });
  };

  return (
    <Group title="About this machine">
      <Row label="Tell your agents about this computer" detail="Added to every run you start here, on Claude Code, Codex and local models. Never to a friend’s or a guest’s run.">
        <Switch label="About this machine" on={on} onChange={handleToggle} />
      </Row>
      <div className={a.editor}>
        <textarea
          className={a.textarea}
          aria-label="About this machine"
          spellCheck={false}
          maxLength={MACHINE_NOTE_MAX}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleBlur}
        />
        <div className={a.bar}>
          <span className={a.muted}>Never put a password or key here. Say where access is, not what it is.</span>
          <span className={a.flex} />
          <span className={a.muted}>
            {text.length} / {MACHINE_NOTE_MAX}
          </span>
        </div>
      </div>
    </Group>
  );
};
