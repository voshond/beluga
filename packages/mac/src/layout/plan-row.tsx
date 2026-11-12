import type { Project } from '@beluga/workspaces/types.js';
import { type Plan, isMultiRepo, planRepos } from '@beluga/core/plans/model.js';
import { isLivePlan, planOfPlace } from '@beluga/core/plans/owner.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext, type ActionItem } from '../components/SpecMenu.js';
import { Badge } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { RepoStack } from '../plans/marks.js';
import { ProgressRing } from '../plans/PlansNav.js';
import { nextWords, planStatus, titleOf } from '../plans/plans-model.js';
import { usePlanActions, usePlanView } from '../plans/use-plans.js';
import { planRowSignal } from './attention-model.js';
import { usePrefs } from '../lib/prefs.js';
import { taskChatsItem } from './plan-task-chats.js';
import { DotMark, nameClass, signalClass } from './signal-marks.js';
import { triageItems } from './row-triage-actions.js';
import { Row } from './sidebar-parts.js';
import { planPlace } from './project-rows.js';
import { useProjectColor } from './row-color-view.js';
import m from './signal.module.css';

/**
 * A plan under its project: one row for the plan, its conversation and all its task worktrees
 * (they stay off the sidebar). Its name, a small ring of how far it got (breathing while Claude
 * works its tasks), a dot when it waits for you, a count of what's new in its own conversation
 * (never its tasks' added up: news there is a quiet dot), as a chat row has.
 * It stays marked while you're in its conversation or in one of its tasks. A plan across repos shows
 * its repos' icons stacked in place of the flag (BLG-33), wherever its row sits.
 */
export function PlanRow({ plan, indent }: { plan: Plan; indent: number }) {
  const view = usePlanView(plan)!;
  const { open, openList } = usePlanActions();
  const uiPrefs = usePrefs();
  // Its project's colour, so the project's rows line up as one rail.
  const color = useProjectColor(plan.projectId);
  // Only what the row shows (not the whole state): drawn again when that changes (KLD-48).
  const selected = useApp((st) => planOfPlace(st.plans, st.board, st.view) === plan.id);
  // What's new at the plan's level (its own conversation); its tasks' worktrees only add a quiet dot (BLG-12).
  const inside = useApp((st) => planRowSignal(st, plan), sameDeep);
  const title = titleOf(plan);
  const status = planStatus(view);
  const unread = inside.unread;
  const planNeeds = status.tone === 'accent' || status.tone === 'error';
  const needs = planNeeds || inside.level === 'needs';
  const working = view.active.some((t) => t.state === 'running') || inside.working;
  const next = nextWords(view.next);
  const why = planNeeds ? (next.detail ? `${next.title}: ${next.detail}` : next.title) : inside.level === 'needs' ? inside.tip : status.label;
  const tip = [`${title}: ${why}`, view.total ? `${view.done} of ${view.total} tasks done` : '', unread ? `${unread} new message${unread === 1 ? '' : 's'}` : inside.inside && !needs ? 'New in its tasks' : ''].filter(Boolean).join(' · ');
  const signal = { level: needs ? 'needs' : unread ? 'unread' : working ? 'working' : 'idle', unread, working, tip } as const;
  const actions = useActions();
  const { client } = useBeluga();
  const items = (): ActionItem[] => [
    { label: 'Open Plan', icon: 'chevronRight', onSelect: () => open(plan.id) },
    ...triageItems(client.store.getState(), `plan:${plan.id}`, actions.run, client),
    ...(plan.status === 'active' ? [taskChatsItem(plan.id, uiPrefs)] : []),
    { label: 'All Plans', separate: true, onSelect: () => openList(plan.projectId) },
  ];
  return (
    <ActionsContext items={items}>
      <Row
        indent={indent}
        selected={selected}
        color={color}
        className={signalClass(signal, selected)}
        aria-label={title}
        data-plan-row={plan.id}
        data-signal-row={signal.level}
        icon={isMultiRepo(plan) ? <RepoStack repos={planRepos(plan)} size={16} /> : <Icon name="flag" size={14} />}
        label={<span className={nameClass(signal)}>{title}</span>}
        detail={tip}
        onClick={() => open(plan.id)}
        trailing={
          <>
            {unread ? (
              <span className={m.count} data-signal="unread">
                <Badge count={unread} urgent />
              </span>
            ) : null}
            {needs ? <DotMark tone={status.tone === 'error' ? 'error' : 'warn'} signal="needs" /> : inside.inside && !unread && !selected ? <DotMark tone="muted" signal="inside" /> : null}
            {/* Tasks running: the plan's orbit (how far it got stays in the tooltip); otherwise how far, as a ring. */}
            {working ? (
              <DotMark tone="plan" live signal="working" />
            ) : (
              <span className={m.mark}>
                <ProgressRing share={view.total ? view.done / view.total : 0} />
              </span>
            )}
          </>
        }
      />
    </ActionsContext>
  );
}

/**
 * The plans across repos that sit under a group (every repo of theirs is in it), above its
 * projects; folded, only the one you're in stays (BLG-20).
 */
export function GroupPlans({ name, groups, folded, indent }: { name: string; groups: ReadonlyArray<{ readonly name: string; readonly projects: readonly Project[] }>; folded: boolean; indent: number }) {
  const all = useApp((st) => st.plans.plans);
  const inPlan = useApp((st) => planOfPlace(st.plans, st.board, st.view));
  const here = all.filter((x) => {
    if (!isLivePlan(x) || (folded && x.id !== inPlan)) return false;
    const place = planPlace(x, groups);
    return 'group' in place && place.group === name;
  });
  return (
    <>
      {here.map((x) => (
        <PlanRow key={x.id} plan={x} indent={indent} />
      ))}
    </>
  );
}
