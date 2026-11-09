import type { Plan } from '@beluga/core/plans/model.js';
import type { PlanView } from '@beluga/core/plans/progress.js';
import { MoveAsk, movePlan } from '@beluga/machines/move-plan.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { toast, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { openSheet } from '../lib/sheets.js';
import { type MoveTarget, useMoveTargets } from '../machines/move-targets.js';
import { onMachine } from '../machines/pane-model.js';
import { stepSays } from './use-plans.js';
import { placeMark } from '../machines/MachineMark.js';

/**
 * Move To ▸ in a plan's ••• (BLG-806): your other computers (and This Mac, from a computer's page)
 * that can take it now. Pause and Move To when something runs in it. What it asks first (Pause and
 * Move, Commit Them and Move) is a sheet; the move itself is the page's busy button, step by step,
 * and opens the plan where it went. A move that fails says why and leaves it where it was.
 */

interface Step {
  readonly run: (what: string, doing: string, task: () => Promise<unknown>, done?: string) => Promise<boolean>;
}

/** Whether anything in the plan runs right now (its agents mid-turn): Move To becomes Pause and Move To. */
export const somethingRuns = (view: PlanView): boolean => view.active.some((t) => t.state === 'running' || t.state === 'asking') || view.milestones.some((m) => m.agentNow);

export function useMoveTo(plan: Plan, view: PlanView, step: Step): ActionItem | undefined {
  const { home } = useBeluga();
  const actions = useActions();
  const where = useMoveTargets();
  if (where.none || plan.movedTo || plan.status === 'done') return undefined;
  const runs = somethingRuns(view);

  const go = (target: MoveTarget, opts: { readonly pause?: boolean; readonly commit?: boolean }): void =>
    void step.run(`move the plan to ${target.place.name}`, `Moving to ${target.place.name}…`, async () => {
      const to = await where.clientFor(target);
      try {
        const moved = await movePlan({
          from: where.fromClient,
          to,
          planId: plan.id,
          fromPlace: where.from,
          toPlace: target.place,
          projectThere: (project) => where.projectOn(target, to, project, (words) => stepSays(plan.id, words)),
          ...opts,
          onStep: (_s, words) => stepSays(plan.id, words),
        });
        toast(home, moved.warning ?? `Moved to ${target.place.name}: it carries on there`, moved.warning ? 'warn' : 'success');
        const page = { kind: 'plan' as const, id: moved.planId };
        actions.run({ type: 'view', view: target.machine ? onMachine(target.machine.id, page) : page });
      } catch (err) {
        if (!(err instanceof MoveAsk)) throw err;
        // Asked first: nothing has moved, and the plan is as it was.
        openSheet(
          err.kind === 'running'
            ? { kind: 'confirm', title: `Pause and move it to ${target.place.name}?`, message: `${err.message.split(':')[0]}. The plan pauses now, waits for that turn to end, then moves; it carries on there.`, confirm: 'Pause and Move', run: () => go(target, { ...opts, pause: true }) }
            : { kind: 'confirm', title: 'Commit the changes and move it?', message: `${err.message.split(':')[0]}. They’re committed on their branch, which moves with the plan; nothing is dropped.`, confirm: 'Commit Them and Move', run: () => go(target, { ...opts, commit: true }) },
        );
      }
    });

  return {
    label: runs ? 'Pause and Move To' : 'Move To',
    hint: runs ? 'Its agents finish their turn first' : 'Its chat, tasks and progress go with it',
    separate: true,
    disabled: !where.targets.length,
    submenu: where.targets.map((t) => ({ label: t.place.name, mark: placeMark(t.machine), onSelect: () => go(t, runs ? { pause: true } : {}) })),
    onSelect: () => undefined,
  };
}
