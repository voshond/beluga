import { useState } from 'react';
import type { Tool, ToolParam } from '@beluga/workspaces/toolbox.js';
import { Checkbox, Field, FormSheet, Popup, SourceTag, TextInput } from '../../components/FormSheet.js';
import { Button, cx } from '../../components/ui.js';
import { Icon } from '../../components/Icon.js';
import { useApi, useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import s from './toolbox.module.css';

type View = 'list' | 'edit';

function emptyDraft(): { name: string; command: string; team: boolean } {
  return { name: '', command: '', team: false };
}

function paramsFrom(command: string): ToolParam[] {
  const seen = new Set<string>();
  const result: ToolParam[] = [];
  for (const m of command.matchAll(/\{\{([^}]+)\}\}/g)) {
    const name = m[1]!.trim();
    if (!seen.has(name)) {
      seen.add(name);
      result.push({ name, kind: 'text' });
    }
  }
  return result;
}

function ToolRow({ tool, onEdit, onApprove, onDelete, approved }: { tool: Tool; onEdit: () => void; onApprove: () => void; onDelete: () => void; approved: boolean }) {
  return (
    <div className={s.toolRow} role="listitem">
      <span className={s.toolIcon}><Icon name="wrench" size={12} /></span>
      <span className={s.toolMain}>
        <span className={s.toolName}>{tool.name}</span>
        <span className={s.toolCmd}>{tool.command}</span>
      </span>
      {tool.source === 'team' && !approved ? (
        <Button size="small" variant="quiet" onClick={onApprove} aria-label={`Approve ${tool.name}`}>Approve</Button>
      ) : (
        <SourceTag tone={tool.source === 'team' ? 'team' : 'mine'}>{tool.source === 'team' ? 'Team' : 'Yours'}</SourceTag>
      )}
      <button type="button" className={s.toolEdit} aria-label={`Edit ${tool.name}`} onClick={onEdit}><Icon name="pencil" size={12} /></button>
      <button type="button" className={cx(s.toolEdit, s.toolDelete)} aria-label={`Delete ${tool.name}`} onClick={onDelete}><Icon name="x" size={12} /></button>
    </div>
  );
}

function ParamRow({ param, onChange }: { param: ToolParam; onChange: (p: ToolParam) => void }) {
  return (
    <div className={s.paramRow}>
      <span className={s.paramName}>{`{{${param.name}}}`}</span>
      <Popup
        value={param.kind}
        onChange={(v) => onChange({ ...param, kind: v as ToolParam['kind'] })}
        options={[
          { value: 'text', label: 'Text' },
          { value: 'host', label: 'SSH host (from ~/.ssh/config)' },
        ]}
      />
    </div>
  );
}

export function ToolboxSheet({ menu, close }: NativeMenuProps<'toolbox'>) {
  const api = useApi();
  const { projectId, projectRoot } = menu;
  const projects = useApp((st) => st.projects);
  const project = projects.find((p) => p.id === projectId);
  const [tools, setTools] = useState<Tool[]>(() => []);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>('list');
  const [editing, setEditing] = useState<Tool | null>(null);
  const [form, setForm] = useState(emptyDraft());
  const [params, setParams] = useState<ToolParam[]>([]);
  const [approved, setApproved] = useState<Set<string>>(new Set());

  const load = (): void => {
    void api.toolbox.list(projectRoot).then((ts) => {
      setTools(ts as Tool[]);
      setLoaded(true);
    });
  };

  if (!loaded) load();

  const refresh = (): void => {
    void api.toolbox.list(projectRoot).then((ts) => setTools(ts as Tool[]));
  };

  const startCreate = (): void => {
    setEditing(null);
    setForm(emptyDraft());
    setParams([]);
    setView('edit');
  };

  const startEdit = (tool: Tool): void => {
    setEditing(tool);
    setForm({ name: tool.name, command: tool.command, team: tool.source === 'team' });
    setParams(tool.params ? [...tool.params] : []);
    setView('edit');
  };

  const handleCommandChange = (cmd: string): void => {
    setForm((f) => ({ ...f, command: cmd }));
    const detected = paramsFrom(cmd);
    setParams((prev) => detected.map((d) => prev.find((p) => p.name === d.name) ?? d));
  };

  const save = (): void | string | Promise<void | string> => {
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name) return 'Enter a name for this tool.';
    if (!command) return 'Enter a command.';
    const mutableParams = params.length ? (params.map((p) => ({ name: p.name, kind: p.kind }))) : undefined;
    const apiArg = { name, command, ...(mutableParams ? { params: mutableParams } : {}), source: (form.team ? 'team' : 'personal') as 'team' | 'personal' };
    const p = editing
      ? api.toolbox.update(projectRoot, editing.id, apiArg)
      : api.toolbox.create(projectRoot, apiArg);
    return (p as Promise<unknown>).then(() => { refresh(); setView('list'); });
  };

  const deleteTool = (tool: Tool): void => {
    void api.toolbox.delete(projectRoot, tool.id).then(refresh);
  };

  const approveTool = (tool: Tool): void => {
    void api.toolbox.approve(projectRoot, tool.id).then(() => setApproved((s) => new Set([...s, tool.id])));
  };

  if (!project) return null;

  if (view === 'edit') {
    const detectedParams = paramsFrom(form.command);
    return (
      <FormSheet
        title={editing ? `Edit "${editing.name}"` : 'New Toolbox Tool'}
        icon="wrench"
        intro={editing ? undefined : 'A named command you can run from the project page without an agent.'}
        submitLabel={editing ? 'Save' : 'Create'}
        canSubmit={form.name.trim().length > 0 && form.command.trim().length > 0}
        onSubmit={save}
        onCancel={() => setView('list')}
        cancelLabel="Back"
        footer={
          <Checkbox
            checked={form.team}
            onChange={(v) => setForm((f) => ({ ...f, team: v }))}
            label="Share with team"
            detail="Saves to beluga.json — others approve before running"
          />
        }
        width={540}
      >
        <Field label="Name" htmlFor="tool-name" hint='Short, action-oriented — e.g. "Deploy to staging", "Run tests".'>
          <TextInput id="tool-name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="Deploy to staging" data-autofocus />
        </Field>
        <Field label="Command" htmlFor="tool-cmd" hint="Use {{param}} for values that change between runs.">
          <TextInput id="tool-cmd" value={form.command} onChange={handleCommandChange} mono placeholder="ssh {{host}} ./deploy.sh" />
        </Field>
        {detectedParams.length > 0 && (
          <Field label="Params" hint="Set the kind for each placeholder.">
            <div className={s.params}>
              {params.map((p) => (
                <ParamRow key={p.name} param={p} onChange={(updated) => setParams((ps) => ps.map((x) => (x.name === updated.name ? updated : x)))} />
              ))}
            </div>
          </Field>
        )}
      </FormSheet>
    );
  }

  return (
    <FormSheet
      title={`${project.name} Toolbox`}
      icon="wrench"
      intro="Named commands you can run from the project page without starting an agent."
      submitLabel="Done"
      onSubmit={close}
      onCancel={close}
      hideSubmit
      width={540}
    >
      {tools.length > 0 ? (
        <div className={s.list} role="list">
          {tools.map((t) => (
            <ToolRow
              key={t.id}
              tool={t}
              approved={approved.has(t.id) || t.source !== 'team'}
              onEdit={() => startEdit(t)}
              onApprove={() => approveTool(t)}
              onDelete={() => deleteTool(t)}
            />
          ))}
        </div>
      ) : (
        <p className={s.empty}>No tools yet. Add one to run commands without an agent.</p>
      )}
      <div className={s.addRow}>
        <Button size="small" icon="plus" onClick={startCreate}>Add Tool</Button>
      </div>
    </FormSheet>
  );
}
