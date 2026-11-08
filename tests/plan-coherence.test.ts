import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import { coherenceWarnings, staleTasks, usesTerm, warningsText } from '../src/core/plans/coherence.js';
import { type BodyInput, PlanError, applyOps, normalizeBody } from '../src/core/plans/edit.js';
import { activeDecisions, reviewState } from '../src/core/plans/model.js';
import { isPlanOwned } from '../src/core/plans/owner.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { createPlanToolDefs } from '../src/agent/plan-tools.js';
import { needsYou } from '../src/companion/needs-you.js';
import { planPageView } from '../src/companion/views.js';
import { headline } from '../packages/mac/src/plans/plans-model.js';
import { planView } from '../src/core/plans/progress.js';
import { verifyProgress } from '../src/core/plans/verify-progress.js';
import { reviewPrompt } from '../src/core/plans/prompt.js';

/** BLG-772: a plan stays one coherent piece while it's changed over many messages. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The Machines plan, as it was first drafted (BLG-767). */
const machines: BodyInput = {
  title: 'Machines',
  goal: 'Work on any machine you paired.',
  milestones: [
    {
      id: 'pair',
      title: 'Pairing',
      criteria: ['A computer pairs'],
      tasks: [
        { id: 'pair-machine', title: 'Pair a machine', goal: 'Pair a second machine with a code.', touches: ['src/net/pair.ts'] },
        { id: 'open-window', title: 'Open in New Window', goal: 'Open a paired machine in a new window.', touches: ['packages/mac/src/window.ts'] },
      ],
    },
    {
      id: 'phone',
      title: 'Phones',
      criteria: ['A phone reaches a computer'],
      tasks: [{ id: 'phone-machines', title: 'Phone reaches machines', goal: 'The phone lists your paired machines and opens one.', touches: ['src/companion/views.ts'] }],
    },
  ],
};

describe('an id that is taken is refused, never renamed (BLG-772)', () => {
  const body = normalizeBody(machines);

  it('add_task with a taken id names the task that has it', () => {
    expect(() => applyOps(body, [{ op: 'add_task', milestone: 'phone', task: { id: 'phone-machines', title: 'Phones reach computers' } }])).toThrow(/already a task "phone-machines": “Phone reaches machines”, in milestone “Phones”.*update_task.*remove_task/);
  });

  it('an id made from a title that is taken is refused too', () => {
    expect(() => applyOps(body, [{ op: 'add_task', milestone: 'pair', task: { title: 'Pair machine' } }])).toThrow(/already a task "pair-machine".*its id comes from its title/);
  });

  it('add_milestone with a taken id, or tasks with taken ids, is refused', () => {
    expect(() => applyOps(body, [{ op: 'add_milestone', milestone: { id: 'phone', title: 'Phones again' } }])).toThrow(/already a milestone "phone": “Phones”/);
    expect(() => applyOps(body, [{ op: 'add_milestone', milestone: { id: 'always-on', title: 'Always On', tasks: [{ id: 'open-window', title: 'Open' }] } }])).toThrow(/already a task "open-window"/);
  });

  it('removing it first, then adding, replaces it on purpose', () => {
    const next = applyOps(body, [{ op: 'remove_task', id: 'phone-machines' }, { op: 'add_task', milestone: 'phone', task: { id: 'phone-machines', title: 'Phones reach computers' } }]);
    expect(next.milestones[1]!.tasks.map((t) => t.title)).toEqual(['Phones reach computers']);
  });

  it('a whole plan with one id twice is refused', () => {
    expect(() => normalizeBody({ ...machines, milestones: [{ title: 'M', tasks: [{ id: 'a', title: 'A' }, { id: 'a', title: 'Another' }] }] })).toThrow(/already a task "a": “A”/);
  });
});

describe('warnings next to "Saved" (BLG-772)', () => {
  it('a clean plan has none', () => {
    expect(coherenceWarnings(normalizeBody(machines))).toEqual([]);
  });

  it('tasks with near-identical titles or goals', () => {
    const body = applyOps(normalizeBody(machines), [{ op: 'add_task', milestone: 'phone', task: { id: 'phone-machine-2', title: 'Phones reach the machines', touches: ['packages/companion/app'] } }]);
    const w = coherenceWarnings(body);
    expect(w.some((x) => x.includes('[phone-machines]') && x.includes('[phone-machine-2]') && x.includes('same work'))).toBe(true);
    const goals = applyOps(normalizeBody(machines), [{ op: 'add_task', milestone: 'pair', task: { id: 'list', title: 'Machines list on the phone', goal: 'The phone lists your paired machines, and opens one.' } }]);
    expect(coherenceWarnings(goals).some((x) => x.includes('near-identical goals'))).toBe(true);
  });

  it('tasks in milestones running side by side that share touches, not once one waits on the other', () => {
    const shared = applyOps(normalizeBody(machines), [{ op: 'add_task', milestone: 'phone', task: { id: 'clone-phone', title: 'Clone the repo for the phone', touches: ['src/net/pair.ts'] } }]);
    const w = coherenceWarnings(shared);
    expect(w.some((x) => x.includes('[pair-machine]') && x.includes('[clone-phone]') && x.includes('src/net/pair.ts') && x.includes('side by side'))).toBe(true);
    const ordered = applyOps(shared, [{ op: 'update_milestone', id: 'phone', dependsOn: ['pair'] }]);
    expect(coherenceWarnings(ordered).some((x) => x.includes('side by side'))).toBe(false);
    // A folder and a file in it are shared too.
    const folder = applyOps(normalizeBody(machines), [{ op: 'add_task', milestone: 'phone', task: { id: 'net', title: 'Network', touches: ['src/net'] } }]);
    expect(coherenceWarnings(folder).some((x) => x.includes('[net]'))).toBe(true);
  });

  it('ids that were removed but are still named, and the blockers that went with them', () => {
    const before = applyOps(normalizeBody(machines), [{ op: 'add_task', milestone: 'pair', task: { id: 'pair-ui', title: 'Pairing screen', goal: 'Shows the code from `pair-machine`.', blockedBy: ['pair-machine'] } }]);
    const after = applyOps(before, [{ op: 'remove_task', id: 'pair-machine' }]);
    const w = coherenceWarnings(after, before);
    expect(w.some((x) => x.includes('"pair-machine" is no longer in the plan') && x.includes('[pair-ui]'))).toBe(true);
    expect(w.some((x) => x.includes('[pair-ui]') && x.includes('waited on pair-machine'))).toBe(true);
  });

  it('a milestone left with no tasks', () => {
    const empty = applyOps(normalizeBody(machines), [{ op: 'remove_task', id: 'phone-machines' }]);
    expect(coherenceWarnings(empty)).toContain('Milestone [phone] “Phones” has no tasks: add its tasks, or remove it.');
  });

  it('the answer lists them, at most a dozen', () => {
    expect(warningsText([])).toBe('');
    const text = warningsText(Array.from({ length: 15 }, (_, i) => `w${i}`));
    expect(text).toContain('Check these before you end your turn');
    expect(text).toContain('- w11');
    expect(text).not.toContain('- w12');
    expect(text).toContain('and 3 more');
  });
});

describe('the plan’s own decisions (BLG-772)', () => {
  const decided = applyOps(normalizeBody(machines), [{ op: 'decide', decision: { id: 'new-window', question: 'Where does a paired computer open?', answer: 'In a new window', terms: ['New Window'] } }]);

  it('decide records one; plan_write without decisions keeps them', () => {
    expect(decided.decisions).toEqual([{ id: 'new-window', question: 'Where does a paired computer open?', answer: 'In a new window', by: 'default', terms: ['New Window'] }]);
    expect(normalizeBody(machines, [decided]).decisions).toEqual(decided.decisions);
    expect(normalizeBody({ ...machines, decisions: [] }, [decided]).decisions).toBeUndefined();
  });

  it('a decision that supersedes another lists the tasks still using the old one', () => {
    const before = decided;
    const after = applyOps(before, [{ op: 'decide', decision: { id: 'one-app', question: 'One app or two?', answer: 'One app, your own client: no separate window', terms: ['your own client'], supersedes: 'new-window' } }]);
    const old = after.decisions!.find((d) => d.id === 'new-window')!;
    expect(old.supersededBy).toBe('one-app');
    expect(activeDecisions(after).map((d) => d.id)).toEqual(['one-app']);
    expect(staleTasks(after, old)).toEqual(['open-window']);
    const w = coherenceWarnings(after, before);
    expect(w.some((x) => x.startsWith('Decision [new-window]') && x.includes('replaced by [one-app]') && x.includes('[open-window] “Open in New Window”') && x.includes('“New Window”'))).toBe(true);
    // Fixed: no warning left.
    const fixed = applyOps(after, [{ op: 'remove_task', id: 'open-window' }]);
    expect(coherenceWarnings(fixed, after).some((x) => x.includes('new-window'))).toBe(false);
  });

  it('a superseded decision with no terms says so once, when it is superseded', () => {
    const plain = applyOps(normalizeBody(machines), [{ op: 'decide', decision: { id: 'trust', question: 'How does pairing trust a computer?', answer: 'With a trust code' } }]);
    const next = applyOps(plain, [{ op: 'decide', decision: { id: 'trust-2', question: 'How does pairing trust a computer?', answer: 'Through your Beluga friends', supersedes: 'trust' } }]);
    expect(coherenceWarnings(next, plain).some((x) => x.includes('gave no terms') && x.includes('plan_get'))).toBe(true);
    expect(coherenceWarnings(next, next).some((x) => x.includes('gave no terms'))).toBe(false);
  });

  it('a word a decision retires is found wherever it is still used', () => {
    const renamed = applyOps(normalizeBody(machines), [{ op: 'decide', decision: { id: 'computers', question: 'What do we call them?', answer: 'Computers', retires: ['machine', 'Auto'] } }]);
    const w = coherenceWarnings(renamed);
    expect(w.some((x) => x.includes('retires') && x.includes('[pair-machine]') && x.includes('[phone-machines]') && x.includes('the plan’s goal'))).toBe(true);
    expect(usesTerm('Phone reaches Machines', 'machine')).toBe(true);
    expect(usesTerm('Automatic', 'Auto')).toBe(false);
  });

  it('superseding an unknown or already replaced decision is refused; removing one brings back the one it replaced', () => {
    expect(() => applyOps(decided, [{ op: 'decide', decision: { question: 'X?', answer: 'X', supersedes: 'nope' } }])).toThrow(/isn't one of the plan's decisions/);
    const after = applyOps(decided, [{ op: 'decide', decision: { id: 'one-app', question: 'One app or two?', answer: 'One app', supersedes: 'new-window' } }]);
    expect(() => applyOps(after, [{ op: 'decide', decision: { question: 'Y?', answer: 'Y', supersedes: 'new-window' } }])).toThrow(/already superseded by "one-app"/);
    const back = applyOps(after, [{ op: 'remove_decision', id: 'one-app' }]);
    expect(back.decisions).toEqual([{ id: 'new-window', question: 'Where does a paired computer open?', answer: 'In a new window', by: 'default', terms: ['New Window'] }]);
    expect(() => applyOps(after, [{ op: 'decide', decision: { id: 'one-app', question: 'Again?', answer: 'Again' } }])).toThrow(/already a decision "one-app"/);
  });
});

function setup(homeTask = false) {
  const store = new Store(initialState('room'));
  const home = homeTask ? ws('home', 'api', 'machines', 'worktree') : ws('home', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>);
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [home])] });
  const asked: Array<{ prompt: string; channel: string; echo: boolean }> = [];
  const archived: string[] = [];
  let n = 0;
  const add = (w: Workspace): void => store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  const controller = {
    onWorktree: () => () => undefined,
    newChat: async (projectId: string, title: string) => {
      const w = ws(`c${++n}`, projectId, title, 'chat', { askOnly: true } as Partial<Workspace>);
      add(w);
      return w;
    },
    renameChat: async () => undefined,
    archive: async (id: string) => {
      archived.push(id);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (w.id === id ? { ...w, archived: true } : w)) })) });
      return true;
    },
    manager: { setAgent: () => undefined },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const work = new PlansWork({ store, plans, board: boardWork, controller, askClaude: (prompt, channel, echo) => `ask-${asked.push({ prompt, channel, echo })}`, intend: () => undefined, delayMs: 0, git: null });
  const run = (channel: string, status: 'started' | 'done', id = `r-${Math.random()}`): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId: id, requester: 'p-me', event: status, text: '', ts: Date.now(), channel });
  const tools = (channel: string) => {
    const got = work.forRun(channel, 'p-me')!;
    return { got, defs: createPlanToolDefs(got.tools!) };
  };
  return { store, board, plans, work, asked, archived, run, tools };
}

describe('the plan tools answer with warnings (BLG-772)', () => {
  it('plan_update says Saved, then what to fix', () => {
    const t = setup();
    const plan = t.work.here('ws:home');
    const { got } = t.tools('ws:home');
    expect(got.tools!.write(machines)).toMatch(/^Saved the draft \(2 milestones, 3 tasks\)\./);
    const said = got.tools!.update([{ op: 'decide', decision: { id: 'new-window', question: 'Where does it open?', answer: 'In a new window', terms: ['New Window'] } }, { op: 'decide', decision: { id: 'one-app', question: 'One app or two?', answer: 'One app, your own client', supersedes: 'new-window' } }]);
    expect(said).toMatch(/^Saved the draft/);
    expect(said).toContain('Check this before you end your turn');
    expect(said).toContain('[open-window] “Open in New Window”');
    expect(() => got.tools!.update([{ op: 'add_task', milestone: 'phone', task: { id: 'phone-machines', title: 'Phones reach computers' } }])).toThrow(/already a task "phone-machines"/);
    // plan_get shows the decisions, and the warnings still standing.
    const shown = got.tools!.get();
    expect(shown).toContain('Decisions:');
    expect(shown).toContain('- [new-window] (replaced by one-app) Where does it open? → In a new window');
    expect(shown).toContain('Warnings (fix them, or say why they are fine):');
    expect(t.plans.need(plan.id).draft!.decisions!.length).toBe(2);
  });

  it('the planner is told to re-read the whole draft when the user changes direction', () => {
    const t = setup();
    t.work.here('ws:home');
    const brief = t.work.forRun('ws:home', 'p-me')!.brief!;
    expect(brief).toContain('When the user changes direction');
    expect(brief).toContain('call plan_get, re-read the WHOLE draft against the plan\'s decisions');
    expect(brief).toContain('fix every task and milestone');
    expect(brief).toContain('make the plan whole again with it');
  });
});

describe('verifying a draft with a fresh agent, when you ask (BLG-772)', () => {
  async function verifying(thenApprove = false) {
    const t = setup();
    const plan = t.work.here('ws:home');
    t.run('ws:home', 'started', 'head-1');
    t.tools('ws:home').got.tools!.write(machines);
    t.run('ws:home', 'done', 'head-1');
    await tick(5);
    // Never by itself: it takes a while, and the cheap checks run on every change.
    expect(t.asked.some((a) => a.prompt.includes('Review the draft'))).toBe(false);
    expect(reviewState(t.plans.need(plan.id))).toBe('none');
    await t.work.verify(plan.id, thenApprove);
    return { t, plan, chat: `ws:${t.plans.need(plan.id).review!.chat}` };
  }

  it('runs in a conversation of its own with only plan_get and plan_review, folded into the plan', async () => {
    const { t, plan, chat } = await verifying();
    const now = t.plans.need(plan.id);
    expect(reviewState(now)).toBe('reviewing');
    expect(t.asked.find((a) => a.channel === chat)?.prompt).toContain('Review the draft of the plan “Machines”');
    const { got, defs } = t.tools(chat);
    expect(got.checker).toBe(true);
    expect(defs.map((d) => d.name)).toEqual(['plan_get', 'plan_review']);
    expect(got.brief).toContain('You are not the agent that wrote it');
    expect(() => got.tools!.update([{ op: 'remove_task', id: 'open-window' }])).toThrow(/only plan_get and plan_review/);
    expect(isPlanOwned(t.store.getState(), now.review!.chat!)).toBe(true);
    expect(headline(planView(now, t.store.getState().board)).text).toBe('A fresh agent is verifying the plan');
  });

  it('Verify, Then Approve: a plan that reads well is approved', async () => {
    const { t, plan, chat } = await verifying(true);
    expect(headline(planView(t.plans.need(plan.id), t.store.getState().board)).text).toBe('A fresh agent is verifying the plan; it’s approved once nothing needs fixing');
    expect(t.tools(chat).got.tools!.review!([])).toMatch(/^Recorded/);
    const now = t.plans.need(plan.id);
    expect(now.status).toBe('active');
    expect(now.review).toBeUndefined();
    expect(t.archived).toContain(chat.slice(3));
  });

  it('its findings reach the plan’s page and the phone, nothing is approved, and Fix sends them to the plan’s agent', async () => {
    const { t, plan, chat } = await verifying(true);
    const said = t.tools(chat).got.tools!.review!([{ kind: 'contradiction', text: 'open-window contradicts “one app”: remove it.', ids: ['open-window'] }]);
    expect(said).toMatch(/^Recorded/);
    const now = t.plans.need(plan.id);
    expect(now.status).toBe('draft');
    expect(reviewState(now)).toBe('findings');
    // The Mac's page.
    expect(headline(planView(now, t.store.getState().board)).text).toBe('Verifying found 1 thing to fix in the plan: Fix, or approve anyway');
    // The phone: the plan's page, and what waits on you.
    expect(planPageView(t.store.getState(), plan.id)!.review).toEqual({ state: 'findings', findings: [{ kind: 'contradiction', text: 'open-window contradicts “one app”: remove it.' }] });
    const card = needsYou(t.store.getState()).find((x) => x.id.startsWith(`plan:${plan.id}:review`));
    expect(card?.actions.map((a) => a.label)).toEqual(['Fix', 'Approve anyway', 'Discard']);
    // Fix: to the plan's agent, shown as yours.
    t.work.fixReview(plan.id);
    const fix = t.asked.at(-1)!;
    expect(fix.channel).toBe('ws:home');
    expect(fix.echo).toBe(true);
    expect(fix.prompt).toContain('1. (contradiction) open-window contradicts');
    expect(t.plans.need(plan.id).review!.fixAsked).toBe(true);
  });

  it('the phone’s approve card offers Verify, then approve', async () => {
    const t = setup();
    const plan = t.work.here('ws:home');
    t.tools('ws:home').got.tools!.write(machines);
    const card = needsYou(t.store.getState()).find((x) => x.id.startsWith(`plan:${plan.id}:approve`));
    expect(card?.actions.map((a) => [a.label, a.method])).toEqual([
      ['Approve', 'plans.approve'],
      ['Verify, then approve', 'plans.verify'],
      ['Discard', 'plans.discard'],
    ]);
  });

  it('a changed draft isn’t verified until asked again, in the same conversation; old findings don’t count', async () => {
    const { t, plan, chat } = await verifying();
    t.tools(chat).got.tools!.review!([]);
    expect(reviewState(t.plans.need(plan.id))).toBe('clean');
    expect(t.plans.need(plan.id).status).toBe('draft');
    t.tools('ws:home').got.tools!.update([{ op: 'remove_task', id: 'open-window' }]);
    expect(reviewState(t.plans.need(plan.id))).toBe('none');
    await t.work.verify(plan.id);
    expect(`ws:${t.plans.need(plan.id).review!.chat}`).toBe(chat);
    expect(t.asked.at(-1)!.prompt).toContain('changed since your last review');
    t.tools('ws:home').got.tools!.update([{ op: 'retitle', goal: 'Work on any computer you paired.' }]);
    expect(t.tools(chat).got.tools!.review!([{ kind: 'other', text: 'old' }])).toMatch(/changed while you read it/);
    t.work.approve(plan.id);
    expect(t.plans.need(plan.id).review).toBeUndefined();
    expect(t.archived).toContain(chat.slice(3));
  });
});

describe('the plan home’s own board task follows the plan (BLG-772)', () => {
  it('its goal and decisions are kept in step', () => {
    const t = setup(true);
    const issue = t.board.create({ projectId: 'api', title: 'Machines', brief: { goal: 'The first idea', decisions: '- Open in a new window' } }, { kind: 'person', id: 'p-me', name: 'Kay' });
    t.board.linkWorktree(issue.id, 'home', { branch: 'beluga/machines', name: 'machines' }, { kind: 'person', id: 'p-me', name: 'Kay' });
    t.work.here('ws:home');
    const tools = t.tools('ws:home').got.tools!;
    tools.write({ ...machines, decisions: [{ id: 'one-app', question: 'One app or two?', answer: 'One app, your own client' }] });
    let brief = t.board.need(issue.id).brief;
    expect(brief.goal).toBe('Work on any machine you paired.');
    expect(brief.decisions).toBe('From the plan “Machines” (its decisions live there; Beluga keeps this in step):\n- One app or two? → One app, your own client');
    tools.update([{ op: 'decide', decision: { id: 'computers', question: 'What do we call them?', answer: 'Call them computers', supersedes: 'one-app' } }]);
    brief = t.board.need(issue.id).brief;
    expect(brief.decisions).toContain('- What do we call them? → Call them computers');
    expect(brief.decisions).not.toContain('One app');
  });
});

describe('verifying shows where it is, never a still line (BLG-772)', () => {
  const run = (text: string, steps: string[] = ['plan_get'], between?: 'thinking'): Parameters<typeof verifyProgress>[0] => ({ text, steps, ts: 1000, status: 'started', ...(between ? { between } : {}) });

  it('starting, then reading, then thinking', () => {
    expect(verifyProgress(undefined).now).toBe('Starting');
    expect(verifyProgress(run('', [])).now).toBe('Reading the plan');
    expect(verifyProgress(run('')).now).toBe('Reading the whole plan');
    expect(verifyProgress(run('', ['plan_get'], 'thinking')).now).toBe('Thinking it over');
    expect(verifyProgress(run('')).checks.every((c) => c.state === 'todo')).toBe(true);
  });

  it('each check lights up as its line comes, the ones before it done', () => {
    const p = verifyProgress(run('Contradictions: reading every task.\n\n**Duplicates**: comparing 8 tasks.'));
    expect(p.checks.map((c) => c.state)).toEqual(['done', 'now', 'todo', 'todo']);
    expect(p.now).toBe('Duplicates: comparing 8 tasks.');
    expect(p.said).toBe(true);
    expect(p.startedAt).toBe(1000);
  });

  it('a check named before a step still counts once its words became a remark', () => {
    const p = verifyProgress({ text: '', steps: ['plan_get'], ts: 1000, status: 'started', remarks: [{ text: 'Contradictions: reading every task.' }, { text: 'Duplicates: comparing 8 tasks.' }] });
    expect(p.checks.map((c) => c.state)).toEqual(['done', 'now', 'todo', 'todo']);
    expect(p.now).toBe('Duplicates: comparing 8 tasks.');
  });

  it('recording what it found: every check is behind it', () => {
    const p = verifyProgress(run('Order: checking what builds on what.', ['plan_get', 'plan_review']));
    expect(p.checks.every((c) => c.state === 'done')).toBe(true);
    expect(p.now).toBe('Writing down what it found');
  });

  it('the verifier is told to name each check as it starts it', () => {
    const t = setup();
    const plan = t.work.here('ws:home');
    t.tools('ws:home').got.tools!.write(machines);
    expect(reviewPrompt(t.plans.need(plan.id), false)).toContain('"Contradictions: …", "Duplicates: …", "Stale: …", "Order: …"');
  });
});
