import { useMemo } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import { BackgroundTasks } from '../../claude-code/BackgroundTasks.js';
import { tasksForWorkspace } from '../../claude-code/background-model.js';
import { useApp } from '../../lib/beluga.js';
import { PortsTab } from './PortsTab.js';

/**
 * The right panel's Background: the commands Claude and its agents run in this workspace in the
 * background (a dev server, the full tests, a build) and watches they keep, live, with the output
 * of the one you pick scrolling as it comes.
 */

/** Something runs in the background here (the tab's dot). */
export function useBackgroundRunning(ws: Workspace | undefined): boolean {
  const sessions = useApp((st) => st.claudeCode.sessions);
  return useMemo(() => Boolean(ws) && tasksForWorkspace(sessions, ws!).some((t) => t.task.status === 'running'), [sessions, ws?.id, ws?.path]);
}

export function BackgroundTab({ wsId }: { wsId: string }) {
  const sessions = useApp((st) => st.claudeCode.sessions);
  const ws = useApp((st) => findWorkspace(st.projects, wsId));
  const items = useMemo(() => (ws ? tasksForWorkspace(sessions, ws) : []), [sessions, ws?.id, ws?.path]);
  return (
    <>
      <PortsTab wsId={wsId} />
      <BackgroundTasks items={items} layout="stack" empty="When your agent or one of its sub-agents starts something to run on its own here (a dev server, the full tests, a build) or keeps watch on something, it shows here, with its output as it comes." />
    </>
  );
}
