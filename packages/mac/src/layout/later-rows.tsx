import { useMemo } from 'react';
import { laterUntil } from '@beluga/core/triage/facts.js';
import { remindLabel } from '@beluga/shared/remind.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useUi } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { Row } from './sidebar-parts.js';
import { WorkspaceWithAgents } from './SubAgents.js';
import side from './Sidebar.module.css';
import s from './project-groups.module.css';

/** When each of your conversations put off till later (Remind Me Later) reminds you, by id: from your records (core/triage). */
export type Later = ReadonlyMap<string, number>;

/** Your conversations put off till later. A reminder that comes changes the records, so this draws again then. */
export function useLater(): Later {
  const pairs = useApp(
    (st) =>
      st.projects.flatMap((p) =>
        p.workspaces.flatMap((w) => {
          const until = w.archived ? undefined : laterUntil(st, `ws:${w.id}`);
          return until === undefined ? [] : [[w.id, until] as const];
        }),
      ),
    sameDeep,
  );
  return useMemo(() => new Map(pairs), [pairs]);
}

/** Conversations put off till later (Remind Me Later, BLG-748), soonest reminder first. */
export const laterOf = (later: Later, list: readonly Workspace[]): Workspace[] => list.filter((w) => later.has(w.id)).sort((a, b) => later.get(a.id)! - later.get(b.id)!);

/** Not put off: what the list shows in its place. */
export const notLater = (later: Later, w: Workspace): boolean => !later.has(w.id);

/**
 * A project's (or Chats') conversations put off till later, out of the way at its bottom: one
 * folded "Later" row with how many, each back in its place once it reminds you. The one you're in
 * still shows under it while folded.
 */
export function LaterRows({ list, indent, foldKey }: { list: readonly Workspace[]; indent: number; foldKey: string }) {
  const actions = useActions();
  const here = useApp((st) => (st.view.kind === 'workspace' ? st.view.id : undefined));
  const open = useUi((u) => u.collapsed.includes(foldKey));
  const later = useLater();
  if (!list.length) return null;
  const shown = open ? list : list.filter((w) => w.id === here);
  const next = remindLabel(later.get(list[0]!.id));
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
