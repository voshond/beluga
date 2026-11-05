import { describe, expect, it } from 'vitest';
import { createPlanToolDefs } from '../src/agent/plan-tools.js';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { PlanDecisions, parseDecisionQid } from '../src/core/plans/decisions.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { milestonePrompt } from '../src/core/plans/prompt.js';
import { PlansWork } from '../src/core/plans/work.js';
import type { ClaudeAnswer, ClaudeQuestion } from '../src/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-6: a milestone's Claude asks you with a structured question; the answer goes on the task and back to it. */

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
};

type Posed = { qid: string; channel: string; question: ClaudeQuestion; onAnswer: (a: ClaudeAnswer) => void };

async function running() {
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
  const posed: Posed[] = [];
  const withdrawn: string[] = [];
  const decisions = new PlanDecisions({
    store,
    plans,
    board: boardWork,
    questions: { pose: (qid, channel, question, onAnswer) => void posed.push({ qid, channel, question, onAnswer }), withdraw: (qid) => void withdrawn.push(qid) },
    askClaude: (prompt, channel) => void ask(prompt, channel),
    schedule: () => work.pilot.schedule(),
  });
  const plan = plans.create({ projectId: 'api', home: 'ws:main', goal: 'Card payments' }, boardWork.me());
  work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
  work.approve(plan.id);
  await tick(10);
  const worktree = plans.need(plan.id).runs.safe!.agent!.worktree;
  const issue = (title: string) => store.getState().board.issues.find((i) => i.title === title)!;
  const workerTools = () => work.forRun(`ws:${worktree}`, 'p-me')!.tools!;
  return { store, board, plans, work, decisions, posed, withdrawn, asked, plan, worktree, issue, workerTools, claude: boardWork.myClaude() };
}

const OPTIONS = [
  { label: 'Stripe Checkout', description: 'Hosted page, least code' },
  { label: 'Payment Element', description: 'Embedded, more control' },
];

describe('a milestone’s Claude asks with a structured question (BLG-6)', () => {
  it('its worktree gets plan_ask and plan_handback only; the plan’s conversation never sees them', async () => {
    const t = await running();
    const worker = t.workerTools();
    expect(worker.worker).toBe(true);
    expect(createPlanToolDefs(worker).map((d) => d.name)).toEqual(['plan_ask', 'plan_handback']);
    const head = createPlanToolDefs(t.work.forRun('ws:main', 'p-me')!.tools!).map((d) => d.name);
    expect(head).toContain('plan_update');
    expect(head).not.toContain('plan_ask');
    expect(head).not.toContain('plan_handback');
    expect(() => worker.update([])).toThrow(/plan_ask and plan_handback are yours here/);
  });

  it('its brief says to ask with plan_ask and decide routine choices itself', async () => {
    const t = await running();
    const view = t.work.pilot.view(t.plans.need(t.plan.id));
    const p = milestonePrompt(view, view.milestones[0]!, view.milestones[0]!.tasks);
    expect(p).toContain('ask it with plan_ask');
    expect(p).toContain('Routine choices are yours');
    expect(p).not.toContain('with task_note on it');
  });

  it('asks in the plan’s conversation, recommended first, and the answer goes on the task and back to its Claude', async () => {
    const t = await running();
    const key = t.issue('Idempotent webhooks').key;
    const said = t.workerTools().ask!({ question: 'Which Stripe integration?', why: 'It decides how much UI we build.', options: OPTIONS, recommended: 'payment element' });
    expect(said).toContain(`Asked the user about ${key}`);
    expect(t.plans.need(t.plan.id).asks?.retries).toMatchObject({ task: 'retries', recommended: 'Payment Element', worktree: t.worktree });
    const card = t.posed.at(-1)!;
    expect(card.channel).toBe('ws:main');
    expect(parseDecisionQid(card.qid)).toEqual({ plan: t.plan.id, task: 'retries', ask: true });
    const q = card.question.kind === 'question' ? card.question.questions[0]! : undefined;
    expect(q?.header).toBe(`${key} · Agent asks`);
    expect(q?.question).toContain('Which Stripe integration?');
    expect(q?.question).toContain('It decides how much UI we build.');
    expect(q?.options.map((o) => o.label)).toEqual(['Payment Element (Recommended)', 'Stripe Checkout']);
    card.onAnswer({ kind: 'answers', answers: { [q!.question]: 'Payment Element (Recommended)' } });
    expect(t.board.need(key).brief.decisions).toContain('- Which Stripe integration? → Payment Element (the user, asked by its agent)');
    expect(t.board.need(key).activity.some((a) => a.kind === 'comment' && a.body === 'Answered: Payment Element')).toBe(true);
    expect(t.plans.need(t.plan.id).asks).toBeUndefined();
    const back = t.asked.at(-1)!;
    expect(back.channel).toBe(`ws:${t.worktree}`);
    expect(back.prompt).toContain('> Which Stripe integration?');
    expect(back.prompt).toContain('\n\nPayment Element\n\n');
    expect(t.store.getState().log.some((l) => l.type === 'system' && l.channel === 'ws:main' && l.text.includes(`You answered ${key}: Payment Element`))).toBe(true);
  });

  it('refuses a question without two different options, or about a task that isn’t its own', async () => {
    const t = await running();
    expect(() => t.workerTools().ask!({ question: 'Which?', options: [{ label: 'A' }, { label: 'a' }] })).toThrow(/at least two different options/);
    expect(() => t.workerTools().ask!({ task: 'NOPE-1', question: 'Which?', options: OPTIONS })).toThrow(/isn’t one of this worktree’s tasks/);
    expect(t.plans.need(t.plan.id).asks).toBeUndefined();
  });

  it('a new question on the same task replaces the card; one whose task is finished is taken back', async () => {
    const t = await running();
    t.workerTools().ask!({ question: 'First?', options: OPTIONS });
    const first = t.posed.at(-1)!.qid;
    await tick(2);
    t.workerTools().ask!({ question: 'Second?', options: OPTIONS });
    expect(t.withdrawn).toContain(first);
    expect(t.plans.need(t.plan.id).asks?.retries?.question).toBe('Second?');
    const second = t.posed.at(-1)!.qid;
    t.board.update(t.issue('Idempotent webhooks').id, { status: 'done' }, t.claude);
    expect(t.withdrawn).toContain(second);
    expect(t.plans.need(t.plan.id).asks).toBeUndefined();
  });
});

describe('a milestone’s Claude hands back work outside its tasks (BLG-7)', () => {
  it('reaches the plan’s head as a plan change to propose, once, in the agent’s words', async () => {
    const t = await running();
    const key = t.issue('Idempotent webhooks').key;
    const before = t.asked.length;
    const said = t.workerTools().handback!('The refund email template double-escapes HTML in src/email/refund.ts.', 'Not a webhook task: it belongs with receipts or a new task.');
    expect(said).toContain('Handed back to the plan');
    const head = t.asked.slice(before).filter((a) => a.channel === 'ws:main');
    expect(head).toHaveLength(1);
    expect(head[0]!.prompt).toContain(`${key} (the agent of milestone “Safe payments”) handed back work`);
    expect(head[0]!.prompt).toContain('<handback>\nThe refund email template double-escapes HTML in src/email/refund.ts.\n</handback>');
    expect(head[0]!.prompt).toContain('Turn it into a plan change with plan_update');
    expect(head[0]!.prompt).toContain('The user approves the change.');
    expect(t.plans.need(t.plan.id).activity.at(-1)?.text).toContain(`${key} handed back: The refund email template`);
    expect(t.workerTools().handback!('The refund email template  double-escapes HTML in src/email/refund.ts.', 'again')).toContain('already');
    expect(t.asked.slice(before).filter((a) => a.channel === 'ws:main')).toHaveLength(1);
  });
});
