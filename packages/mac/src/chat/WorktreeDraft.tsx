import type { AgentRef } from '@beluga/protocol.js';
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import type { BranchList } from '@beluga/workspaces/types.js';
import { Select } from '../components/Select.js';
import { branchOptions } from './branch-options.js';
import { Tip } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './draft.module.css';

/** What a new worktree starts from and is called (empty name: Beluga names it from the task). */
export interface WorktreeChoice {
  readonly base?: string;
  readonly name: string;
  /** Its own agent (the composer's picker, BLG-446); unset: your default. */
  readonly agent?: AgentRef;
}

/**
 * The top of the message box for a new worktree: which project, the branch it starts from
 * (a pop-up, searchable when there are many) and an optional name. The task below is Claude's first message.
 */
export function WorktreeDraft({ projectId, choice, onChange }: { projectId: string; choice: WorktreeChoice; onChange: (c: WorktreeChoice) => void }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const [branches, setBranches] = useState<BranchList>();
  useEffect(() => {
    let alive = true;
    setBranches(undefined);
    api.workspaces.branches(projectId).then(
      (b) => alive && b && setBranches(b),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  const base = choice.base ?? branches?.base ?? project?.base ?? '';
  const options = branches?.branches.length ? branches.branches : base ? [base] : [];
  return (
    <div className={s.draft} role="group" aria-label="New worktree">
      <span className={s.project}>
        <Icon name="branch" size={12} />
        {project?.name ?? 'Project'}
      </span>
      <label className={s.field}>
        <span className={s.fieldLabel}>Based on</span>
        <Tip label="The branch the new one starts from (origin branches are fetched first, so it's the latest)">
          <Select className={s.select} size="small" mono label="Based on" value={base} onChange={(b) => onChange({ ...choice, base: b })} options={branchOptions(options, branches?.base, branches?.remotes)} searchPlaceholder="Find a branch" />
        </Tip>
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>Name</span>
        <input
          className={`${s.name} selectable`}
          aria-label="Worktree name"
          placeholder="from the task"
          value={choice.name}
          maxLength={60}
          spellCheck={false}
          onChange={(e) => onChange({ ...choice, name: e.target.value })}
          onKeyDown={(e) => {
            // Return in the name goes to the task (or creates it when there's no task).
            if (e.key === 'Enter') {
              e.preventDefault();
              document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
            }
          }}
        />
      </label>
    </div>
  );
}
