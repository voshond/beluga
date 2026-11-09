import { RemoteList } from '../machines/RemoteList.js';
import { remotePlans } from '../machines/remote-work.js';
import { useRemoteSources } from '../machines/use-remote.js';
import { useEffect, useMemo } from 'react';
import { type Plan, isMultiRepo, planRepos } from '@beluga/core/plans/model.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { currentSheet, openSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ago } from '../tasks/tasks-model.js';
import { MilestoneBar, RepoStack, TonePill } from './marks.js';
import { bars, nextWords, planSections, planStatus, titleOf } from './plans-model.js';
import { usePlanActions, usePlanView, usePlans } from './use-plans.js';
import p from './plans.module.css';
import v from './PlansView.module.css';
import { SharedPlansList } from '../team/SharedPlans.js';
import { isShortcut } from '../lib/shortcuts.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { NoProjects } from '../work/NoProjects.js';

/**
 * Plans: every project's (or one project's, picked in the bar). What runs or waits comes first,
 * finished plans under it; a plan across repos shows in each of its repos. New Plan (⌘N) starts one with Claude.
 */

const ALL = 'all';

export function PlansView() {
  const state = usePlans();
  const view = useApp((s) => s.view);
  const all = useApp((s) => s.projects);
  const projects = useMemo(() => all.filter((x) => x.root && !x.error), [all]);
  const { openList } = usePlanActions();
  const asked = view.kind === 'plans' ? view.projectId : undefined;
  const here = projects.find((x) => x.id === asked);
  const { now, finished } = planSections(state, here?.id);
  const newPlan = (): void => openSheet({ kind: 'new_plan', ...(here ? { projectId: here.id } : {}) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || currentSheet()) return;
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]');
      if (!typing && isShortcut('page-new', e)) {
        e.preventDefault();
        e.stopPropagation();
        openSheet({ kind: 'new_plan', ...(here ? { projectId: here.id } : {}) });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [here]);

  if (!state.enabled) return <Empty icon="flag" title="Plans need the Beluga app" detail="Open the Beluga app to plan big work with your agent." />;
  if (!projects.length) return <NoProjects icon="flag" detail="Plans belong to a project. Add one to plan its work here." />;
  const name = here?.name ?? 'All Projects';
  const choices = [{ value: ALL, label: 'All Projects', mark: <Icon name="flag" size={14} /> }, ...projects.map((x) => ({ value: x.id, label: x.name, mark: <ProjectIcon id={x.id} name={x.name} size={16} /> }))];
  return (
    <div className={p.list}>
      <div className={p.listBar}>
        <span className={v.caption}>Plans in</span>
        <PickMenu<string> label="Project" choices={choices} chosen={[here?.id ?? ALL]} onPick={(id) => openList(id === ALL ? undefined : id)}>
          <button type="button" className={cx(p.projectSwitch, v.switch)} aria-label={`Project: ${name}`} title="Switch Project">
            {here ? <ProjectIcon id={here.id} name={here.name} size={18} /> : <Icon name="flag" size={15} />}
            <span>{name}</span>
            <Icon name="chevronDown" size={11} />
          </button>
        </PickMenu>
        <span className={p.grow} />
        <ActionsDropdown items={[{ label: 'Planning Style…', onSelect: () => openSheet({ kind: 'plan_style' }) }]}>
          <IconButton icon="more" label="Plans Options" />
        </ActionsDropdown>
        <Button variant="primary" size="small" icon="plus" onClick={newPlan} title={`New Plan${shortcutKeys('page-new') ? ` (${shortcutKeys('page-new')})` : ''}`}>
          New Plan
        </Button>
      </div>
      <div className={v.scroll}>
        {now.length || finished.length ? (
          <>
            <PlanSection label="Running and drafts" plans={now} showProject={!here} />
            <PlanSection label="Finished" plans={finished} showProject={!here} />
          </>
        ) : (
          <Empty
            icon="flag"
            mark={here ? <ProjectIcon id={here.id} name={here.name} size={28} /> : undefined}
            title={here ? `No plans in ${here.name} yet` : 'No plans yet'}
            detail="Say what you want built. Your agent reads the code and cuts it into milestones and tasks that run side by side, each with what proves it’s done. You talk it through; nothing reaches the board until you approve."
            action={
              <EmptyActions>
                <Button variant="primary" icon="plus" onClick={newPlan}>
                  {here ? `Plan in ${here.name}` : 'New Plan'}
                </Button>
              </EmptyActions>
            }
          />
        )}
        <SharedPlansList projectId={here?.id} />
        {/* The same project's plans on your computers (BLG-785). */}
        <RemotePlans {...(here ? { project: here.name } : {})} />
      </div>
    </div>
  );
}

function PlanSection({ label, plans, showProject }: { label: string; plans: readonly Plan[]; showProject: boolean }) {
  if (!plans.length) return null;
  return (
    <>
      <div className={v.section}>{label}</div>
      <ul className={p.rows} aria-label={label}>
        {plans.map((plan) => (
          <PlanRow key={plan.id} plan={plan} showProject={showProject} />
        ))}
      </ul>
    </>
  );
}

function PlanRow({ plan, showProject }: { plan: Plan; showProject: boolean }) {
  const view = usePlanView(plan)!;
  const { open } = usePlanActions();
  const project = useApp((s) => s.projects.find((x) => x.id === plan.projectId));
  const status = planStatus(view);
  const next = nextWords(view.next);
  const multi = isMultiRepo(plan);
  const where = showProject && project && !multi ? `${project.name} · ` : '';
  const sub = plan.body ? (next.detail ? `${next.title} · ${next.detail}` : next.title) : `${view.milestones.length} milestones · ${view.total} tasks · draft`;
  return (
    <li>
      <button type="button" className={p.row} onClick={() => open(plan.id)} aria-label={`${titleOf(plan)}, ${status.label}`}>
        {multi ? <RepoStack repos={planRepos(plan)} size={16} /> : showProject && project ? <ProjectIcon id={project.id} name={project.name} size={16} /> : null}
        <span className={p.rowMain}>
          <span className={p.rowTitle}>{titleOf(plan)}</span>
          <span className={p.rowSub}>{`${where}${sub}`}</span>
        </span>
        {view.milestones.length && plan.body ? <MilestoneBar items={bars(view)} /> : null}
        <TonePill tone={status.tone} live={status.tone === 'claude'}>
          {status.label}
        </TonePill>
        <span className={p.rowWhen}>{ago(plan.updatedAt)}</span>
      </button>
    </li>
  );
}

/** The plans of the project of this name on your computers, tagged. */
function RemotePlans({ project }: { project?: string }) {
  const sources = useRemoteSources();
  const rows = useMemo(() => remotePlans(sources).filter((t) => !project || t.item.project === project).map((t) => ({ ...t, item: { id: t.item.id, title: t.item.title, sub: t.item.status, page: { kind: 'plan' as const, id: t.item.id } } })), [sources, project]);
  return <RemoteList title="Plans on your computers" rows={rows} />;
}

