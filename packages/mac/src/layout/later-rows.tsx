import { remindLabel, remindPending } from '@beluga/shared/remind.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useUi } from '../lib/beluga.js';
import { Row } from './sidebar-parts.js';
import { WorkspaceWithAgents } from './SubAgents.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';

/** Conversations put off till later (Remind Me Later, BLG-748), soonest reminder first. */
export const laterOf = (list: readonly Workspace[], now = Date.now()): Workspace[] =>
  list.filter((w) => !w.archived && remindPending(w, now)).sort((a, b) => a.remindAt! - b.remindAt!);

/** Not put off: what the list shows in its place. */
export const notLater = (w: Workspace, now = Date.now()): boolean => !remindPending(w, now);

/**
 * A project's (or Chats') conversations put off till later, out of the way at its bottom: one
 * folded "Later" row with how many, each back in its place once it reminds you. The one you're in
 * still shows under it while folded.
 */
export function LaterRows({ list, indent, foldKey }: { list: readonly Workspace[]; indent: number; foldKey: string }) {
  const actions = useActions();
  const here = useApp((st) => (st.view.kind === 'workspace' ? st.view.id : undefined));
  const open = useUi((u) => u.collapsed.includes(foldKey));
  if (!list.length) return null;
  const shown = open ? list : list.filter((w) => w.id === here);
  const next = remindLabel(list[0]!);
  return (
    <>
      <Row
        indent={indent}
        className={side.fold}
        aria-expanded={open}
        aria-label={`Later, ${list.length}`}
        // The arrow in the gutter, as a worktree folding its sub-agents (the whole row folds).
        icon={
          <span className={side.foldIcon}>
            <span className={side.agentFold} aria-hidden="true">
              <Icon name="chevronRight" size={9} className={cx(side.agentDisclosure, open && side.agentDisclosureOpen)} />
            </span>
            <Icon name="clock" size={14} />
          </span>
        }
        label="Later"
        detail={`${list.length === 1 ? 'One conversation' : `${list.length} conversations`} you asked to be reminded about${next ? `\nThe next one: ${next.replace(/^Reminds you /, '')}` : ''}`}
        trailing={<span className={s.count}>{list.length}</span>}
        onClick={() => actions.run({ type: 'toggle_fold', key: foldKey })}
      />
      {shown.map((w) => (
        <WorkspaceWithAgents key={w.id} ws={w} indent={indent + 1} />
      ))}
    </>
  );
}
