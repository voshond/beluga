import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { PlanError, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { diffBodies, isEmptyDiff, proposedRepos, reposWith } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { PlanView } from '../src/companion/protocol.js';
import { planPageView } from '../src/companion/views.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const base = ['api', 'cal'];
const body = () => normalizeBody({ title: 'Delete stale recordings', goal: '', milestones: [{ id: 'gw', title: 'Gateway', tasks: [{ id: 't1', title: 'Discard route' }] }] }, [], base);

describe('a draft’s repo changes (BLG-29)', () => {
  it('adds a repo the plan doesn’t cover, and its milestones may name it', () => {
    const b = applyOps(body(), [{ op: 'repo', repo: 'desk', on: true, why: 'the delete button lives there' }, { op: 'update_milestone', id: 'gw', repos: ['desk'] }], base);
    expect(b.repoChanges).toEqual([{ repo: 'desk', change: 'add', why: 'the delete button lives there', by: 'claude' }]);
    expect(b.milestones[0]!.repos).toEqual(['desk']);
    expect(reposWith(base, b.repoChanges)).toEqual(['api', 'cal', 'desk']);
  });

  it('a milestone can’t name a repo that isn’t in the plan or added', () => {
    expect(() => applyOps(body(), [{ op: 'update_milestone', id: 'gw', repos: ['desk'] }], base)).toThrow(/isn't one of this plan's repos/);
  });

  it('drops a repo the plan covers, never the primary nor one a milestone works in', () => {
    const dropped = applyOps(body(), [{ op: 'repo', repo: 'cal', on: false, why: 'nothing changes there' }], base);
    expect(dropped.repoChanges).toEqual([{ repo: 'cal', change: 'drop', why: 'nothing changes there', by: 'claude' }]);
    expect(reposWith(base, dropped.repoChanges)).toEqual(['api']);
    expect(() => applyOps(body(), [{ op: 'repo', repo: 'api', on: false }], base)).toThrow(/primary repo stays/);
    const using = applyOps(body(), [{ op: 'update_milestone', id: 'gw', repos: ['cal'] }], base);
    expect(() => applyOps(using, [{ op: 'repo', repo: 'cal', on: false }], base)).toThrow(PlanError);
  });

  it('turning a change around takes it back', () => {
    const added = applyOps(body(), [{ op: 'repo', repo: 'desk', on: true }], base);
    expect('repoChanges' in applyOps(added, [{ op: 'repo', repo: 'desk', on: false }], base)).toBe(false);
    const dropped = applyOps(body(), [{ op: 'repo', repo: 'cal', on: false }], base);
    expect('repoChanges' in applyOps(dropped, [{ op: 'repo', repo: 'cal', on: true }], base)).toBe(false);
  });

  it('counts as a change to approve', () => {
    const b = body();
    const added = applyOps(b, [{ op: 'repo', repo: 'desk', on: true }], base);
    expect(diffBodies(b, added).repos).toBe(1);
    expect(isEmptyDiff(diffBodies(b, added))).toBe(false);
  });

  it('a whole plan keeps the repo changes drafted before, and takes its own', () => {
    const was = applyOps(body(), [{ op: 'repo', repo: 'desk', on: true }], base);
    const next = normalizeBody({ title: 'Again', goal: '', milestones: [{ title: 'Web', repos: ['web'] }], repoEdits: [{ repo: 'web', on: true, why: 'its page' }] }, [was], base);
    expect(next.repoChanges?.map((c) => `${c.change}:${c.repo}`)).toEqual(['add:desk', 'add:web']);
  });
});

const chat: Workspace = { id: 'main', projectId: 'api', name: 'calendar-desktop', path: '/tmp/desk', kind: 'chat', projectRoot: '/tmp/desk', branch: 'main', createdAt: 0, external: false, askOnly: true };

function planning() {
  const calRoot = mkdtempSync(path.join(tmpdir(), 'calendar-api-'));
  writeFileSync(path.join(calRoot, 'AGENTS.md'), '# calendar-api\nThe gateway the desktop app calls for transcripts.\n');
  const projects: Project[] = [
    { id: 'api', name: 'calendar-desktop', root: '/tmp/desk', base: 'main', workspaces: [chat] },
    { id: 'cal', name: 'calendar-api', root: calRoot, base: 'main', workspaces: [] },
    { id: 'whisper', name: 'whisper-api', root: '/tmp/whisper', base: 'main', workspaces: [] },
    { id: 'units', name: 'unit-frames', root: '/tmp/units', base: 'main', workspaces: [] },
  ];
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects, groups: [{ name: 'Calendar', projects: ['/tmp/desk', calRoot, '/tmp/whisper'] }] });
  const controller = { onWorktree: () => () => undefined } as Pick<WorkspaceController, 'onWorktree'> as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const plansWork = new PlansWork({ store, plans, board: work, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0 });
  const plan = plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'step' }, work.myClaude());
  const run = () => plansWork.forRun('ws:main', 'p-me')!;
  return { store, plans, plansWork, plan, run, calRoot };
}

describe('planning finds the repos near it (BLG-28, BLG-30)', () => {
  it('a one-repo plan hears of its group’s repos (with their AGENTS.md) and the rest by name', () => {
    const t = planning();
    const brief = t.run().brief!;
    expect(brief).toContain(`- calendar-api (id cal), in the "Calendar" group: ${t.calRoot}`);
    expect(brief).toContain('The gateway the desktop app calls for transcripts.');
    expect(brief).toContain('Other projects on this Mac (not readable unless you add one): unit-frames.');
    expect(brief).toContain('Which repos the work reaches is yours to work out');
    expect(t.plansWork.homeReads('main')).toEqual([t.calRoot, '/tmp/whisper']);
  });

  it('the agent adds a repo by name and plans its milestone there; one not on this Mac is refused', () => {
    const t = planning();
    const tools = t.run().tools!;
    tools.write({ title: 'Delete stale recordings', goal: 'g', milestones: [{ id: 'gw', title: 'Gateway discard', repos: ['calendar-api'], tasks: [{ id: 'route', title: 'Discard route' }] }, { id: 'ui', title: 'Delete buttons', tasks: [{ id: 'btn', title: 'Delete button' }] }], repoEdits: [{ repo: 'calendar-api', on: true, why: 'DELETE /documents/:id returns 409' }] });
    const draft = t.plans.need(t.plan.id).draft!;
    expect(draft.repoChanges).toEqual([{ repo: 'cal', change: 'add', why: 'DELETE /documents/:id returns 409', by: 'claude' }]);
    expect(draft.milestones[0]!.repos).toEqual(['cal']);
    expect(proposedRepos(t.plans.need(t.plan.id))).toEqual(['api', 'cal']);
    expect(() => tools.update([{ op: 'repo', repo: 'friends-api', on: true, why: 'x' }])).toThrow(/isn’t a project on this Mac \(near this plan: whisper-api, unit-frames\)/);
    const view = PlanView.parse(planPageView(t.store.getState(), t.plan.id));
    expect(view.repos).toEqual(['calendar-desktop', 'calendar-api']);
    expect(view.repoChanges).toEqual([{ name: 'calendar-api', change: 'add', by: 'claude', why: 'DELETE /documents/:id returns 409' }]);
    expect(view.milestones.map((m) => m.repos)).toEqual([['calendar-api'], ['calendar-desktop']]);
  });

  it('turning down the agent’s suggestion is your decision, which it holds to', () => {
    const t = planning();
    const tools = t.run().tools!;
    tools.write({ title: 'Plan', goal: '', milestones: [{ id: 'ui', title: 'UI', tasks: [{ id: 'a', title: 'A' }] }] });
    tools.update([{ op: 'repo', repo: 'whisper-api', on: true, why: 'its cancel hook' }]);
    t.plansWork.edit(t.plan.id, [{ op: 'repo', repo: 'whisper', on: false }]);
    const draft = t.plans.need(t.plan.id).draft!;
    expect(draft.repoChanges).toBeUndefined();
    expect(draft.decisions).toEqual([{ question: 'Should this plan cover whisper-api?', answer: 'No: leave whisper-api out', by: 'user' }]);
  });

  it('approving applies the repos: the plan covers them, its tasks run in their repos', () => {
    const t = planning();
    t.run().tools!.write({ title: 'Delete stale recordings', goal: 'g', milestones: [{ id: 'gw', title: 'Gateway discard', repos: ['calendar-api'], tasks: [{ id: 'route', title: 'Discard route' }] }, { id: 'ui', title: 'Delete buttons', tasks: [{ id: 'btn', title: 'Delete button' }] }], repoEdits: [{ repo: 'calendar-api', on: true, why: 'the 409' }] });
    const approved = t.plansWork.approve(t.plan.id);
    expect(approved.repos).toEqual(['api', 'cal']);
    expect(approved.draft).toBeUndefined();
    expect(approved.board).toBeUndefined();
    const issues = t.store.getState().board.issues;
    expect(issues.find((i) => i.title === 'Discard route')?.projectId).toBe('cal');
    expect(issues.find((i) => i.title === 'Discard route')?.board).toBeUndefined();
    expect(issues.find((i) => i.title === 'Delete button')?.projectId).toBe('api');
    expect(approved.activity.some((e) => e.text === 'added calendar-api')).toBe(true);
  });
});
