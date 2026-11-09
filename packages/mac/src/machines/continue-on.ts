import { continueOn } from '@beluga/machines/move.js';
import { MoveAsk } from '@beluga/machines/move-plan.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { openSheet } from '../lib/sheets.js';
import { type MoveTarget, useMoveTargets } from './move-targets.js';
import { onMachine } from './pane-model.js';
import { noteStarted } from './started.js';
import { placeMark } from './MachineMark.js';

/**
 * Continue On ▸ in a worktree's ••• (BLG-808): your other computers (This Mac from a computer's
 * page). Its branch and its conversation go there, its .env is asked about as for any new
 * worktree, and the old one is archived once the new one is there. Changes not committed are asked
 * about (Commit Them and Continue), never dropped; while its agent works, it waits for the turn.
 */
export function useContinueOn(ws: Workspace | undefined): ActionItem | undefined {
  const { home } = useBeluga();
  const actions = useActions();
  const where = useMoveTargets();
  if (!ws || where.none || ws.kind !== 'worktree' || !ws.branch || ws.archived) return undefined;
  const name = ws.name;

  const go = async (target: MoveTarget, opts: { readonly commit?: boolean; readonly wait?: boolean }): Promise<void> => {
    toast(home, `Continuing ${name} on ${target.place.name}…`, 'info');
    try {
      const to = await where.clientFor(target);
      const made = await continueOn({
        from: where.fromClient,
        to,
        workspaceId: ws.id,
        fromPlace: where.from,
        toPlace: target.place,
        projectThere: (project) => where.projectOn(target, to, project, () => undefined),
        ...opts,
      });
      if (target.machine) noteStarted(target.machine.id, `ws:${made}`);
      toast(home, `${name} continues on ${target.place.name}, with its branch and conversation`, 'success');
      const page = { kind: 'workspace' as const, id: made, tab: 'chat' as const };
      actions.run({ type: 'view', view: target.machine ? onMachine(target.machine.id, page) : page });
    } catch (err) {
      if (err instanceof MoveAsk) {
        openSheet(
          err.kind === 'dirty'
            ? { kind: 'confirm', title: `Commit the changes and continue on ${target.place.name}?`, message: `${name} has changes not committed: ${err.items.join(', ')}. They’re committed on ${ws.branch}, which goes there; nothing is dropped.`, confirm: 'Commit Them and Continue', run: () => void go(target, { ...opts, commit: true }) }
            : { kind: 'confirm', title: `Continue on ${target.place.name} once its turn ends?`, message: `Its agent is at work. It continues there as soon as this turn ends.`, confirm: 'Continue Then', run: () => void go(target, { ...opts, wait: true }) },
        );
        return;
      }
      toast(home, `Couldn’t continue ${name} on ${target.place.name}: ${err instanceof Error ? err.message : String(err)}. It stays here as it was.`, 'error');
    }
  };

  return {
    label: 'Continue On',
    hint: 'Its branch and conversation go along',
    separate: true,
    disabled: !where.targets.length,
    submenu: where.targets.map((t) => ({ label: t.place.name, mark: placeMark(t.machine), onSelect: () => void go(t, {}) })),
    onSelect: () => undefined,
  };
}
