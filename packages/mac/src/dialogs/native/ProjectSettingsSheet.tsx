import { useEffect, useState } from 'react';
import type { ResolvedScripts } from '@beluga/workspaces/scripts.js';
import { Checkbox, Field, FormSheet, SourceTag, TextInput } from '../../components/FormSheet.js';
import { useApi, useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';

type Kind = 'setup' | 'run';
type Source = NonNullable<ResolvedScripts['setup']>['source'];

const SOURCE: Record<Source, { label: string; tone: 'team' | 'mine' | 'guess'; detail: string }> = {
  yours: { label: 'Your settings', tone: 'mine', detail: 'Only you have it' },
  claude: { label: 'By your agent', tone: 'guess', detail: 'Your agent worked it out from the project (only you have it). Change it if it’s wrong' },
  'beluga.json': { label: 'beluga.json', tone: 'team', detail: 'Shared with everyone on the project' },
  'klaud.json': { label: 'klaud.json', tone: 'team', detail: 'Shared with everyone on the project' },
  'conductor.json': { label: 'conductor.json', tone: 'team', detail: 'A setup file in the project, shared with everyone on it' },
  detected: { label: 'Guessed', tone: 'guess', detail: 'Beluga guessed it from the project. Change it if it’s wrong' },
};

/**
 * A project's Setup and Run commands, as a form: where each one comes from now, and whether to
 * keep yours to yourself or save them in the project's beluga.json for the whole team.
 */
export function ProjectSettingsSheet({ menu, close }: NativeMenuProps<'scripts'>) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === menu.projectId));
  const autoSetup = useApp((st) => st.prefs.autoSetup);
  const scripts = project?.scripts ?? {};
  const [values, setValues] = useState<Record<Kind, string>>({ setup: scripts.setup?.command ?? '', run: scripts.run?.command ?? '' });
  const [team, setTeam] = useState(false);
  const [auto, setAuto] = useState(autoSetup);
  const [touched, setTouched] = useState(false);
  // Until you type, the fields follow what's saved (it can arrive just after the sheet opens).
  const setupNow = scripts.setup?.command ?? '';
  const runNow = scripts.run?.command ?? '';
  useEffect(() => {
    if (!touched) setValues({ setup: setupNow, run: runNow });
  }, [setupNow, runNow]);
  if (!project) return null;

  const saved = (kind: Kind): string => scripts[kind]?.command ?? '';
  const edited = (kind: Kind): boolean => values[kind].trim() !== saved(kind);
  const tag = (kind: Kind) => {
    const s = scripts[kind];
    if (edited(kind)) return <SourceTag tone={team ? 'team' : 'mine'}>{team ? 'Will go in beluga.json' : 'Will be yours'}</SourceTag>;
    return s ? (
      <span title={SOURCE[s.source].detail}>
        <SourceTag tone={SOURCE[s.source].tone}>{SOURCE[s.source].label}</SourceTag>
      </span>
    ) : (
      <SourceTag tone="guess">None</SourceTag>
    );
  };
  // Guessed values say so (once), so you check them.
  const hint = (kind: Kind, what: string) => (!edited(kind) && scripts[kind]?.source === 'detected' ? `${what} Guessed from the project: check it.` : !edited(kind) && scripts[kind]?.source === 'claude' ? `${what} Your agent worked it out from the project: check it.` : what);
  const changed = edited('setup') || edited('run') || team || auto !== autoSetup;

  const save = (): void => {
    for (const kind of ['setup', 'run'] as const) {
      const value = values[kind].trim();
      // Saving for the team writes both commands into beluga.json, or the older klaud.json it has (and drops your own ones).
      if (team && (value || scripts[kind])) void api.workbench.setScript(project.id, kind, value, true);
      else if (!team && edited(kind)) void api.workbench.setScript(project.id, kind, value);
    }
    if (auto !== autoSetup) void api.session.setPrefs({ autoSetup: auto });
    close();
  };

  return (
    <FormSheet
      title={`${project.name} Settings`}
      icon="terminal"
      intro="The commands every workspace of this project uses. Leave one empty for none."
      submitLabel="Save"
      canSubmit={changed}
      onSubmit={save}
      onCancel={close}
      width={560}
      footer={<Checkbox checked={team} onChange={setTeam} label="Save to beluga.json" detail="Everyone on the project gets them (commit the file)" />}
    >
      <Field label="Setup" htmlFor="script-setup" hint={hint('setup', 'Runs in each new worktree, e.g. to install dependencies.')} aside={tag('setup')}>
        <TextInput id="script-setup" value={values.setup} onChange={(v) => (setTouched(true), setValues({ ...values, setup: v }))} mono placeholder="npm install" />
      </Field>
      <Field label="Run" htmlFor="script-run" hint={hint('run', 'Starts the project when you click Run.')} aside={tag('run')}>
        <TextInput id="script-run" value={values.run} onChange={(v) => (setTouched(true), setValues({ ...values, run: v }))} mono placeholder="npm run dev" />
      </Field>
      <Field label="">
        <Checkbox checked={auto} onChange={setAuto} label="Run setup in new worktrees" detail="For every project; in its Terminal tab" />
      </Field>
    </FormSheet>
  );
}
