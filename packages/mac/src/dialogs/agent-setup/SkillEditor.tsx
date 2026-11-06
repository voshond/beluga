import { useEffect, useState } from 'react';
import { type AgentSetupResult, SKILL_NAME_RE, skillTemplate } from '@beluga/shared/agent-setup.js';
import { Button } from '../../components/ui.js';
import { useApi } from '../../lib/beluga.js';
import a from './agent-setup.module.css';

type SkillEditorProps = {
  readonly name?: string;
  readonly onDone: (changed: boolean) => void;
};

const problemOf = (result: AgentSetupResult): string | undefined => ('error' in result ? result.error : undefined);

const NewSkill = ({ onCreated, onCancel }: { readonly onCreated: (name: string) => void; readonly onCancel: () => void }) => {
  const api = useApi();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const valid = SKILL_NAME_RE.test(name) && description.trim().length > 0;

  const handleCreate = async () => {
    const problem = problemOf(await api.agentSetup.saveSkill(name, skillTemplate(name, description.trim()), true));
    if (problem) return setError(problem);
    onCreated(name);
  };

  return (
    <div className={a.editor}>
      <div className={a.bar}>
        <input className={`${a.field} ${a.name}`} aria-label="Skill name" placeholder="deploy-to-nas" autoFocus spellCheck={false} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
        <input className={`${a.field} ${a.description}`} aria-label="Skill description" placeholder="When to use it: deploy a built site to the NAS over SSH" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className={a.bar}>
        {error ? <span className={a.error}>{error}</span> : <span className={a.muted}>Lowercase letters, digits and dashes. The description tells Claude Code and Codex when to use it.</span>}
        <span className={a.flex} />
        <Button size="small" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="small" variant="primary" disabled={!valid} onClick={() => void handleCreate()}>
          Create
        </Button>
      </div>
    </div>
  );
};

const EditSkill = ({ name, onDone }: { readonly name: string; readonly onDone: (changed: boolean) => void }) => {
  const api = useApi();
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void api.agentSetup.readSkill(name).then((found) => setText(found ?? ''));
  }, [api, name]);

  const handleSave = async () => {
    if (text === undefined) return;
    const problem = problemOf(await api.agentSetup.saveSkill(name, text, false));
    if (problem) return setError(problem);
    onDone(true);
  };

  const handleDelete = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    const problem = problemOf(await api.agentSetup.removeSkill(name));
    if (problem) return setError(problem);
    onDone(true);
  };

  return (
    <div className={a.editor}>
      <textarea className={`${a.textarea} ${a.tall}`} aria-label={`SKILL.md of ${name}`} spellCheck={false} disabled={text === undefined} value={text ?? 'Loading…'} onChange={(e) => setText(e.target.value)} />
      <div className={a.bar}>
        <Button size="small" variant="danger" onClick={() => void handleDelete()}>
          {confirmDelete ? 'Delete for Claude Code and Codex' : 'Delete'}
        </Button>
        {error ? <span className={a.error}>{error}</span> : null}
        <span className={a.flex} />
        <Button size="small" variant="quiet" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button size="small" variant="primary" disabled={text === undefined} onClick={() => void handleSave()}>
          Save
        </Button>
      </div>
    </div>
  );
};

export const SkillEditor = ({ name, onDone }: SkillEditorProps) => {
  const [created, setCreated] = useState<string>();
  const editing = name ?? created;
  if (editing) return <EditSkill key={editing} name={editing} onDone={(changed) => onDone(changed || Boolean(created))} />;
  return <NewSkill onCreated={setCreated} onCancel={() => onDone(false)} />;
};
