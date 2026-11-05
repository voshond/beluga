import { describe, expect, it } from 'vitest';
import { createPlanToolDefs, toOps } from '../src/agent/plan-tools.js';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { planPageView } from '../src/companion/views.js';
import { type BodyInput, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { diffBodies, isEmptyDiff } from '../src/core/plans/model.js';
import { Plans } from '../src/core/plans/plans.js';
import { checkPrompt, describePlan, milestonePrompt, planningBrief } from '../src/core/plans/prompt.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-8: clarify first, then commit. Decisions and open questions are part of the plan, and approving waits on the questions. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take card payments safely.',
  milestones: [
    {
      id: 'safe',
      title: 'Safe payments',
      criteria: ['A replayed webhook charges once'],
      tasks: [
        { id: 'retries', title: 'Idempotent webhooks', acceptance: ['each event once'] },
        { id: 'receipts', title: 'Receipts once', blockedBy: ['retries'] },
      ],
    },
  ],
  decisions: [
    { question: 'Which payment provider?', answer: 'Stripe', by: 'user', tasks: ['retries'] },
    { question: 'How long are webhook ids kept?', answer: '30 days', why: 'Stripe retries for 3 days; 30 leaves room', tasks: ['retries', 'receipts'] },
  ],
  openQuestions: ['Do refunds send a receipt too?'],
};

function setup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>)])] });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const asked: Array<{ prompt: string; channel: string }> = [];
  let n = 0;
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => {
      listeners.push(l);
      return () => undefined;
    },
    newWorktree: async (projectId: string, name: string) => {
      const w = ws(`w${++n}`, projectId, name);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const ask = (prompt: string, channel: string): string => `ask-${asked.push({ prompt, channel })}`;
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt, channel) => void ask(prompt, channel) });
  const plans = new Plans({ store, dir: null });
  const work = new PlansWork({ store, plans, board: boardWork, controller, git: null, askClaude: ask, intend: () => undefined, delayMs: 0 });
  const plan = plans.create({ projectId: 'api', home: 'ws:main', goal: 'Card payments' }, boardWork.me());
  const tools = () => work.forRun('ws:main', 'p-me')!.tools!;
  const issue = (title: string) => store.getState().board.issues.find((i) => i.title === title)!;
  return { store, board, plans, work, plan, tools, issue, asked };
}

describe('decisions and open questions are part of the plan (BLG-8)', () => {
  it('a written plan keeps them: a default unless said otherwise, one per question, an answered question no longer open', () => {
    const body = normalizeBody({
      ...BODY,
      decisions: [...BODY.decisions!, { question: 'which payment provider?', answer: 'Stripe Checkout', by: 'user' }, { question: 'Do refunds send a receipt too?', answer: 'Yes' }],
      openQuestions: ['Do refunds send a receipt too?', 'Is tax in scope?', 'is tax in scope?'],
    });
    expect(body.decisions?.map((d) => [d.question, d.answer, d.by])).toEqual([
      ['which payment provider?', 'Stripe Checkout', 'user'],
      ['How long are webhook ids kept?', '30 days', 'default'],
      ['Do refunds send a receipt too?', 'Yes', 'default'],
    ]);
    expect(body.openQuestions).toEqual(['Is tax in scope?']);
    expect(() => normalizeBody({ ...BODY, decisions: [{ question: 'Q?', answer: 'A', tasks: ['nope'] }] })).toThrow(/names task "nope", which isn't in the plan/);
  });

  it('decide closes the question it answers; open_question opens and drops one; a removed task leaves its decisions', () => {
    const body = normalizeBody(BODY);
    const answered = applyOps(body, [{ op: 'decide', decision: { question: 'Do refunds send a receipt too?', answer: 'No', by: 'user' } }]);
    expect(answered.openQuestions).toBeUndefined();
    expect(answered.decisions?.at(-1)).toEqual({ question: 'Do refunds send a receipt too?', answer: 'No', by: 'user' });
    const reopened = applyOps(answered, [{ op: 'open_question', question: 'Is tax in scope?', on: true }]);
    expect(reopened.openQuestions).toEqual(['Is tax in scope?']);
    expect(applyOps(reopened, [{ op: 'open_question', question: 'is tax in scope?', on: false }]).openQuestions).toBeUndefined();
    const cut = applyOps(body, [{ op: 'remove_task', id: 'receipts' }]);
    expect(cut.decisions?.find((d) => d.question.startsWith('How long'))?.tasks).toEqual(['retries']);
  });

  it('changing only a decision is a change to an approved plan', () => {
    const body = normalizeBody(BODY);
    const d = diffBodies(body, applyOps(body, [{ op: 'decide', decision: { question: 'How long are webhook ids kept?', answer: '90 days' } }]));
    expect(d.decisions).toBe(2);
    expect(isEmptyDiff(d)).toBe(false);
    expect(isEmptyDiff(diffBodies(body, body))).toBe(true);
  });

  it('the planning tools take them: plan_write’s decisions and open_questions, plan_update’s decide and open_question', async () => {
    const t = setup();
    const write = createPlanToolDefs(t.tools()).find((d) => d.name === 'plan_write')!;
    const args = { title: 'Payments', goal: 'Take card payments safely.', milestones: [{ title: 'Safe payments', criteria: ['ok'], tasks: [{ id: 'retries', title: 'Idempotent webhooks' }] }], decisions: [{ question: 'Provider?', answer: 'Stripe', tasks: ['retries'] }], open_questions: ['Tax?'] };
    const said = await (write as unknown as { handler: (a: typeof args) => Promise<{ isError?: boolean }> }).handler(args);
    expect(said.isError).toBeFalsy();
    expect(t.plans.need(t.plan.id).draft).toMatchObject({ decisions: [{ question: 'Provider?', answer: 'Stripe', by: 'default', tasks: ['retries'] }], openQuestions: ['Tax?'] });
    expect(toOps([{ op: 'decide', decision: { question: 'Tax?', answer: 'Out of scope', by: 'user' } }])).toEqual([{ op: 'decide', decision: { question: 'Tax?', answer: 'Out of scope', by: 'user' } }]);
  });
});

describe('approving commits it (BLG-8)', () => {
  it('waits while a question is open, says which, and approves anyway when asked', () => {
    const t = setup();
    t.tools().write(BODY);
    expect(() => t.work.approve(t.plan.id)).toThrow(/A question is still open: “Do refunds send a receipt too\?”.*approve anyway/);
    expect(t.plans.need(t.plan.id).body).toBeUndefined();
    t.work.approve(t.plan.id, undefined, { anyway: true });
    expect(t.plans.need(t.plan.id).body?.openQuestions).toEqual(['Do refunds send a receipt too?']);
  });

  it('puts each decision in the briefs of the tasks it names, and a re-approval adds only what’s new', () => {
    const t = setup();
    t.tools().write({ ...BODY, openQuestions: [] });
    t.work.approve(t.plan.id);
    expect(t.issue('Idempotent webhooks').brief.decisions).toBe('- Which payment provider? → Stripe\n- How long are webhook ids kept? → 30 days (a default, not asked) — Stripe retries for 3 days; 30 leaves room');
    expect(t.issue('Receipts once').brief.decisions).toBe('- How long are webhook ids kept? → 30 days (a default, not asked) — Stripe retries for 3 days; 30 leaves room');
    t.tools().update([{ op: 'decide', decision: { question: 'Are receipts emailed?', answer: 'Yes, by Postmark', by: 'user', tasks: ['receipts'] } }]);
    t.work.approve(t.plan.id);
    expect(t.issue('Receipts once').brief.decisions).toBe('- How long are webhook ids kept? → 30 days (a default, not asked) — Stripe retries for 3 days; 30 leaves room\n- Are receipts emailed? → Yes, by Postmark');
    expect(t.issue('Idempotent webhooks').brief.decisions).not.toContain('Postmark');
  });
});

describe('the agents hear it (BLG-8)', () => {
  it('the planner is told to look first, ask with a recommended answer, write defaults down and write the plan once', () => {
    const t = setup();
    const brief = planningBrief(t.plans.need(t.plan.id), t.store.getState().board, '');
    expect(brief).toContain('How to plan: clarify first, then commit.');
    expect(brief).toContain('Read the code (and the board) before your first question');
    expect(brief).toContain('"(Recommended)"');
    expect(brief).toContain('Don\'t ask what has a sensible default');
    expect(brief).toContain('open_questions');
    expect(brief).not.toContain('risks and open questions');
  });

  it('plan_get, the milestone’s Claude and its checker read the decisions and what was left open', async () => {
    const t = setup();
    t.tools().write(BODY);
    expect(t.tools().get()).toContain('Open questions (approval waits on them):\n- Do refunds send a receipt too?');
    t.work.approve(t.plan.id, undefined, { anyway: true });
    await tick(10);
    const view = t.work.pilot.view(t.plans.need(t.plan.id));
    expect(describePlan(view)).toContain('- Which payment provider? → Stripe (user) [tasks retries]');
    const m = view.milestones[0]!;
    const brief = milestonePrompt(view, m, m.tasks);
    expect(brief).toContain('Decided while planning (hold to these;');
    expect(brief).toContain('- How long are webhook ids kept? → 30 days (a default)');
    expect(brief).toContain('Left open when the plan was approved');
    expect(checkPrompt(view, m)).toContain('Work that goes against a decision is a gap too.');
  });
});

describe('on the phone (BLG-8)', () => {
  it('the plan page lists decisions and open questions; the approve card says what’s open and approves anyway', () => {
    const t = setup();
    t.tools().write(BODY);
    const pv = planPageView(t.store.getState(), t.plan.id)!;
    expect(pv.openQuestions).toEqual(['Do refunds send a receipt too?']);
    expect(pv.decisions?.map((d) => d.by)).toEqual(['user', 'default']);
    const card = pv.needsYou.find((n) => n.id.startsWith(`plan:${t.plan.id}:approve`))!;
    expect(card.detail).toContain('A question is still open:\n• Do refunds send a receipt too?');
    expect(card.actions?.[0]).toMatchObject({ label: 'Approve Anyway', method: 'plans.approve', args: [t.plan.id, { anyway: true }] });
  });
});
