import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import type { PlanPr } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { allNeeds } from '../src/companion/needs-you.js';
import { COMPANION_PROTO, PlanView } from '../src/companion/protocol.js';
import { planPageView } from '../src/companion/views.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const chat: Workspace = { id: 'main', projectId: 'api', name: 'bob-api', path: '/tmp/bob-api', kind: 'chat', projectRoot: '/tmp/bob-api', branch: 'main', createdAt: 0, external: false, askOnly: true };
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

const BODY: BodyInput = {
  title: 'Invites',
  goal: 'One feature across three repos',
  milestones: [
    { id: 'contract', title: 'Invite API', repos: ['cal'], tasks: [{ id: 'schema', title: 'Invite schema' }] },
    { id: 'desktop', title: 'Desktop invites', repos: ['desk'], dependsOn: ['contract'], tasks: [{ id: 'ui', title: 'Invite UI' }] },
    { id: 'hooks', title: 'Transcripts', dependsOn: ['desktop'], tasks: [{ id: 'hook', title: 'Transcript hook' }] },
  ],
};

const pr = (repo: string, number: number, over: Partial<PlanPr> = {}): PlanPr => ({ number, url: `https://github.com/bob/${repo}/pull/${number}`, state: 'OPEN', title: 'Invites', draft: false, checks: 'passing', ...over });

function shipping() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [chat]), project('cal', 'calendar-api'), project('desk', 'calendar-desktop')] });
  const controller = { onWorktree: () => () => undefined } as Pick<WorkspaceController, 'onWorktree'> as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const plansWork = new PlansWork({ store, plans, board: work, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0 });
  const plan = plans.create({ projectId: 'api', repos: ['api', 'cal', 'desk'], home: 'ws:main', autonomy: 'step' }, work.myClaude());
  plansWork.forRun('ws:main', 'p-me')!.tools!.write(BODY);
  plansWork.approve(plan.id);
  for (const repo of ['cal', 'desk', 'api']) plans.setBranch(plan.id, 'plan/invites', true, repo);
  for (const i of store.getState().board.issues.filter((x) => ['Invite schema', 'Invite UI', 'Transcript hook'].includes(x.title))) board.planMoved(i.id, 'in_plan', 'merged into plan/invites');
  for (const m of ['contract', 'desktop', 'hooks']) plans.pass(plan.id, m, work.me());
  const view = () => PlanView.parse(planPageView(store.getState(), plan.id));
  return { store, plans, plan, view };
}

describe('a plan across repos on the phone: each repo’s PR (BLG-17)', () => {
  it('lists each repo’s branch and PR in merge order, with what’s next', () => {
    const t = shipping();
    expect(t.view().ship).toEqual({
      repos: [
        { name: 'calendar-api', branch: 'plan/invites' },
        { name: 'calendar-desktop', branch: 'plan/invites' },
        { name: 'bob-api', branch: 'plan/invites' },
      ],
      next: 'Open PRs on your Mac: calendar-api, calendar-desktop, bob-api have none open',
    });
    t.plans.setPr(t.plan.id, pr('cal', 7, { state: 'MERGED' }), 'cal');
    t.plans.setShipped(t.plan.id, { at: 1, how: 'pr', number: 7 }, 'cal');
    t.plans.setPr(t.plan.id, pr('desk', 8, { checks: 'pending' }), 'desk');
    t.plans.setPr(t.plan.id, pr('api', 9), 'api');
    const ship = t.view().ship!;
    expect(ship.repos[0]).toMatchObject({ name: 'calendar-api', merged: true, pr: { ref: 'bob/cal#7', state: 'MERGED' } });
    expect(ship.repos[1]).toMatchObject({ pr: { ref: 'bob/desk#8', state: 'OPEN', words: 'checks running', url: 'https://github.com/bob/desk/pull/8' } });
    expect(ship.next).toBe('Merge All on your Mac: 1 of 3 merged');
  });

  it('a closed PR and a stuck conflict are Needs You items naming the repo', () => {
    const t = shipping();
    t.plans.setPr(t.plan.id, pr('desk', 8, { state: 'CLOSED' }), 'desk');
    t.plans.setMainMerge(t.plan.id, { at: 1, main: 'origin/main', projectId: 'cal', conflict: { at: 2, dir: '/tmp/.bases/cal', files: ['src/invite.ts'], stuck: true } });
    const needs = allNeeds(t.store.getState()).filter((n) => n.id.startsWith(`plan:${t.plan.id}`));
    expect(needs.map((n) => n.title)).toEqual(['A merge conflict in calendar-api Claude couldn’t fix', 'calendar-desktop’s pull request bob/desk#8 was closed']);
    expect(needs[0]!.actions).toEqual([{ label: 'Ask Claude again', tone: 'main', method: 'plans.retryConflicts', args: [t.plan.id] }]);
    expect(t.view().needsYou.map((n) => n.id)).toContain(`plan:${t.plan.id}:closed:desk`);
  });

  it('an older phone parses the view without it (additive in this minor)', () => {
    const t = shipping();
    const { ship: _ship, ...older } = t.view();
    expect(PlanView.parse(older).ship).toBeUndefined();
    expect(COMPANION_PROTO.minor).toBeGreaterThanOrEqual(44);
  });
});
