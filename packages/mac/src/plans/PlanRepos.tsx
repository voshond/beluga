import { MAX_PLAN_REPOS, type Plan, type PlanRepoChange, planRepos, proposedRepos } from '@beluga/core/plans/model.js';
import type { PlanView } from '@beluga/core/plans/progress.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { repoProgress } from './plans-model.js';
import { usePlanActions } from './use-plans.js';
import p from './plans.module.css';

type Project = { readonly id: string; readonly name: string; readonly root: string };

const changeTitle = (c: PlanRepoChange, name: string): string => {
  const who = c.by === 'user' ? 'You' : 'Your agent';
  const what = c.change === 'add' ? `${who} added ${name}` : `${who} dropped ${name}`;
  return `${what}${c.why ? `: ${c.why}` : ''}. Approving applies it`;
};

/**
 * Where a plan's work happens (BLG-31): its repos as chips with their sidebar icons, primary first.
 * A draft's repo changes show as + (added) and − (dropped) with why on hover, each turned down with ✕
 * (your agent hears it and won't suggest it again); Repos… puts one in or takes one out yourself.
 * Approving applies them: the plan then has a branch, a pull request and a merge step in each repo.
 * Once it runs, each chip says how far that repo's tasks got (BLG-33).
 */
export function PlanRepos({ view }: { view: PlanView }) {
  const plan = view.plan;
  const projects = useApp((st) => st.projects);
  const progress = repoProgress(view);
  const { api, act } = usePlanActions();
  const changes = plan.draft?.repoChanges ?? [];
  const covered = proposedRepos(plan);
  const local: readonly Project[] = projects.filter((x) => x.root);
  const nameOf = (id: string): string => local.find((x) => x.id === id)?.name ?? id;
  const changeOf = (id: string): PlanRepoChange | undefined => changes.find((c) => c.repo === id);
  const dropped = changes.filter((c) => c.change === 'drop');
  const usedBy = new Set((plan.draft ?? plan.body)?.milestones.flatMap((m) => m.repos ?? []) ?? []);
  if (plan.status === 'done' && !changes.length && planRepos(plan).length < 2) return null;

  const setRepo = (repo: string, on: boolean): void => void act(() => api.edit(plan.id, [{ op: 'repo', repo, on }]));

  const menu: ActionItem[] = local.map((x) => {
    const inPlan = covered.includes(x.id);
    const primary = x.id === plan.projectId;
    const busy = inPlan && usedBy.has(x.id);
    const full = !inPlan && covered.length >= MAX_PLAN_REPOS;
    return {
      label: x.name,
      checked: inPlan,
      disabled: primary || busy || full,
      ...(primary ? { hint: 'The plan’s own repo' } : busy ? { hint: 'A milestone works in it' } : full ? { hint: `A plan covers at most ${MAX_PLAN_REPOS} repos` } : {}),
      onSelect: () => setRepo(x.id, !inPlan),
    };
  });

  return (
    <div className={p.repoRow} role="list" aria-label="Repos this plan works in">
      {covered.map((id) => {
        const change = changeOf(id);
        const name = nameOf(id);
        return (
          <span key={id} role="listitem" className={cx(p.repoPill, change && p.repoAdded)} title={change ? changeTitle(change, name) : id === plan.projectId ? `${name}: the plan’s own repo` : name}>
            {change ? <span className={p.repoMark}>+</span> : null}
            <ProjectIcon id={id} name={name} size={13} />
            <span className={p.repoName}>{name}</span>
            {plan.body && covered.length > 1 && progress.get(id)?.total ? (
              <span className={p.repoCount} aria-label={`${progress.get(id)!.done} of ${progress.get(id)!.total} tasks done`}>
                {progress.get(id)!.done}/{progress.get(id)!.total}
              </span>
            ) : null}
            {change ? (
              <button type="button" className={p.repoUndo} aria-label={`Leave ${name} out`} title={`Leave ${name} out`} onClick={() => setRepo(id, false)}>
                <Icon name="x" size={10} />
              </button>
            ) : null}
          </span>
        );
      })}
      {dropped.map((c) => {
        const name = nameOf(c.repo);
        return (
          <span key={c.repo} role="listitem" className={cx(p.repoPill, p.repoDropped)} title={changeTitle(c, name)}>
            <span className={p.repoMark}>−</span>
            <ProjectIcon id={c.repo} name={name} size={13} />
            <span className={p.repoName}>{name}</span>
            <button type="button" className={p.repoUndo} aria-label={`Keep ${name}`} title={`Keep ${name}`} onClick={() => setRepo(c.repo, true)}>
              <Icon name="x" size={10} />
            </button>
          </span>
        );
      })}
      {plan.status === 'done' ? null : (
        <ActionsDropdown items={menu}>
          <Button size="small" variant="quiet" icon="plus" title="Put a repo in this plan, or take one out">
            Repos
          </Button>
        </ActionsDropdown>
      )}
      {changes.length ? <span className={p.repoHint}>{plan.body ? 'Applying the changes applies these' : 'Approving applies these'}</span> : null}
    </div>
  );
}
