import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { landPlan } from '../src/core/plans/move.js';
import { Plans } from '../src/core/plans/plans.js';
import { planView } from '../src/core/plans/progress.js';
import { attachPlans } from '../src/core/plans/registry.js';
import { PlansWork } from '../src/core/plans/work.js';
import { type LogItem, Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import { PLANS_API } from '../src/ipc/plans-api.js';
import { PLANS_HANDLERS } from '../src/ipc/plans-handlers.js';
import { MoveAsk, type MoveCaller, movePlan } from '../src/machines/move-plan.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-806: a plan moves to another computer with its chat, tasks and progress, and nothing is dropped when it fails. */

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'chat'): Workspace => ({ id, projectId, name, path: `/tmp/nowhere-${id}`, kind, projectRoot: '/tmp/nowhere', createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string): Project => ({ id, name, root: `/tmp/nowhere-${name}`, base: 'main', workspaces: [] });

/** One computer: its store, board, plans and a fake controller (chats and their saved history). */
function computer(projectId: string, projectName: string) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project(projectId, projectName)] });
  const histories = new Map<string, readonly unknown[]>();
  const archived: string[] = [];
  let n = 0;
  const find = (id: string): Workspace | undefined => store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  const made: Array<{ name: string; base?: string }> = [];
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => (listeners.push(l), () => undefined),
    newWorktree: async (pid: string, name: string, o: { base?: string } = {}) => {
      made.push({ name, ...(o.base ? { base: o.base } : {}) });
      const w = { ...ws(`${projectId}-w${++n}`, pid, name, 'worktree'), branch: `beluga/${name}` } as Workspace;
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === pid ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
    newChat: async (pid: string, name: string) => {
      const w = ws(`${projectId}-c${++n}`, pid, name);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === pid ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
      return w;
    },
    archive: async (id: string) => (archived.push(id), true),
    manager: { find, loadHistory: (id: string) => histories.get(id) ?? [], saveHistory: (id: string, items: readonly unknown[]) => void histories.set(id, items), setAgent: () => undefined },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => projectName });
  const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  const plans = new Plans({ store, dir: null });
  const plansWork = new PlansWork({ store, plans, board: work, controller, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0 });
  const session = {};
  attachPlans(session, plansWork);
  // Its daemon as your app calls it: each call checked against the API, then handled.
  const caller: MoveCaller & { fail?: string } = {
    async call(method: string, ...args: unknown[]) {
      if (caller.fail === method) throw new Error(`${method} failed`);
      const spec = PLANS_API[method as keyof typeof PLANS_API];
      const parsed = spec.args.parse(args) as unknown[];
      return (PLANS_HANDLERS[method as keyof typeof PLANS_HANDLERS] as (s: object, ...a: unknown[]) => unknown)(session, ...parsed);
    },
  };
  return { store, board, plans, plansWork, controller, histories, archived, caller, projectId, made };
}

const BODY: BodyInput = {
  title: 'Parser',
  goal: 'A faster parser.',
  milestones: [
    { id: 'm1', title: 'Fast', criteria: ['fast'], tasks: [{ id: 'a', title: 'Lexer' }, { id: 'b', title: 'Grammar', blockedBy: ['a'] }] },
    { id: 'm2', title: 'Ship', criteria: ['shipped'], tasks: [{ id: 'c', title: 'Release', blockedBy: ['b'] }] },
  ],
};

/** A running plan on `c`: approved, its first task in review, a conversation with what was said. */
async function runningPlan(c: ReturnType<typeof computer>): Promise<Plan> {
  const chat = await c.controller.newChat(c.projectId, 'Plan: Parser');
  const home = `ws:${chat!.id}`;
  const plan = c.plans.create({ projectId: c.projectId, home }, c.board.state().issues[0]?.createdBy ?? { kind: 'beluga' });
  c.plans.writeDraft(plan.id, BODY, { kind: 'beluga' });
  c.plansWork.approve(plan.id);
  const first = c.plans.need(plan.id).body!.milestones[0]!.tasks[0]!;
  c.board.update(first.issueId!, { status: 'in_review' }, { kind: 'beluga' });
  c.board.editBrief(first.issueId!, 'handoff', 'Lexer done, grammar next.', { kind: 'beluga' });
  const said: LogItem[] = [
    { id: 'h1', type: 'chat', channel: home, from: 'p-me', name: 'Kay', text: 'make the parser faster', ts: 1, byAgent: false },
    { id: 'h2', type: 'chat', channel: home, from: 'p-me', name: 'Claude', text: 'Here is the plan.', ts: 2, byAgent: true },
  ] as unknown as LogItem[];
  c.histories.set(chat!.id, said);
  return c.plans.need(plan.id);
}

const move = (a: ReturnType<typeof computer>, b: ReturnType<typeof computer>, planId: string, extra: Partial<Parameters<typeof movePlan>[0]> = {}) =>
  movePlan({ from: a.caller, to: b.caller, planId, fromPlace: { name: 'This Mac' }, toPlace: { id: '0123456789abcdef', name: 'build-box' }, projectThere: async () => b.projectId, sleep: async () => undefined, ...extra });

const progress = (c: ReturnType<typeof computer>, id: string) => {
  const v = planView(c.plans.need(id), c.board.state());
  return { done: v.done, total: v.total, milestones: v.milestones.map((m) => [m.milestone.title, m.state, m.tasks.map((t) => [t.task.title, t.state, t.issue?.key])]) };
};

describe('Move To another computer (BLG-806)', () => {
  it('moves the plan with its chat, board tasks and progress, and it carries on there', async () => {
    const a = computer('api', 'bob-api');
    const b = computer('api2', 'bob-api');
    const plan = await runningPlan(a);
    const before = progress(a, plan.id);
    const keys = a.board.state().issues.map((i) => i.key).sort();

    const moved = await move(a, b, plan.id);
    expect(moved.planId).toBe(plan.id);

    // There: the same plan, running (not paused), in that project, with the same progress and task keys.
    const there = b.plans.need(plan.id);
    expect(there.projectId).toBe('api2');
    expect(there.paused).toBe(false);
    expect(there.movedFrom?.name).toBe('This Mac');
    expect(there.body?.title).toBe('Parser');
    expect(progress(b, plan.id)).toEqual(before);
    expect(b.board.state().issues.map((i) => i.key).sort()).toEqual(keys);
    const lexer = b.board.get(there.body!.milestones[0]!.tasks[0]!.issueId!)!;
    expect(lexer.brief.handoff).toBe('Lexer done, grammar next.');
    expect(lexer.projectId).toBe('api2');
    expect(there.epics).toBeDefined();
    // Its chat came along, in its new conversation there.
    const said = b.histories.get(there.home.slice(3)) as LogItem[];
    expect(said.filter((l) => l.type === 'chat').map((l) => (l as { text: string }).text)).toEqual(['make the parser faster', 'Here is the plan.']);
    expect(said.every((l) => l.channel === there.home)).toBe(true);

    // Here: only its record, paused, off the lists; its tasks in the Archive; its conversation put away.
    const record = a.plans.need(plan.id);
    expect(record.movedTo).toMatchObject({ id: '0123456789abcdef', name: 'build-box', planId: plan.id });
    expect(record.paused).toBe(true);
    expect(a.board.state().issues.every((i) => i.archivedAt && i.movedTo === 'build-box')).toBe(true);
    expect(a.archived).toContain(plan.home.slice(3));
    await expect(a.plansWork.startTask(plan.id, 'b')).rejects.toThrow(/moved to build-box/);
  });

  it('keeps old keys as aliases where the board there names them differently', async () => {
    const a = computer('api', 'bob-api');
    const b = computer('core', 'api-core');
    b.board.create({ projectId: 'core', title: 'Something already there' }, { kind: 'beluga' });
    const plan = await runningPlan(a);
    const oldKey = a.board.get(plan.body!.milestones[0]!.tasks[0]!.issueId!)!.key;
    await move(a, b, plan.id);
    const moved = b.board.get(oldKey);
    expect(moved?.title).toBe('Lexer');
    expect(moved?.key).not.toBe(oldKey);
    expect(moved?.aliases).toEqual([oldKey]);
    // The plan there links its tasks there.
    expect(b.plans.need(plan.id).body!.milestones[0]!.tasks[0]!.issueId).toBe(moved?.id);
  });

  it('a move that fails on the way leaves the plan where it was, working', async () => {
    const a = computer('api', 'bob-api');
    const b = computer('api2', 'bob-api');
    const plan = await runningPlan(a);
    // Landing there fails (that project isn't there): nothing is left there, and it runs again here.
    await expect(move(a, b, plan.id, { projectThere: async () => 'missing' })).rejects.toThrow(/project isn’t here/);
    expect(a.plans.need(plan.id)).toMatchObject({ paused: false });
    expect(a.plans.need(plan.id).movedTo).toBeUndefined();
    expect(a.board.state().issues.some((i) => i.archivedAt)).toBe(false);
    expect(b.plans.list()).toEqual([]);
    expect(b.board.state().issues).toEqual([]);
  });

  it('when the old copy can’t be put away, the new one is taken back off', async () => {
    const a = computer('api', 'bob-api');
    const b = computer('api2', 'bob-api');
    const plan = await runningPlan(a);
    a.caller.fail = 'plans.moveDone';
    await expect(move(a, b, plan.id)).rejects.toThrow(/moveDone failed/);
    expect(b.plans.list()).toEqual([]);
    expect(b.board.state().issues).toEqual([]);
    expect(a.plans.need(plan.id)).toMatchObject({ paused: false });
    expect(a.plans.need(plan.id).movedTo).toBeUndefined();
    // And it can move once that works.
    a.caller.fail = undefined;
    await move(a, b, plan.id);
    expect(b.plans.need(plan.id).paused).toBe(false);
  });

  it('moves back again over its own record', async () => {
    const a = computer('api', 'bob-api');
    const b = computer('api2', 'bob-api');
    const plan = await runningPlan(a);
    const before = progress(a, plan.id);
    await move(a, b, plan.id);
    await movePlan({ from: b.caller, to: a.caller, planId: plan.id, fromPlace: { id: '0123456789abcdef', name: 'build-box' }, toPlace: { name: 'This Mac' }, projectThere: async () => 'api' });
    const back = a.plans.need(plan.id);
    expect(back.movedTo).toBeUndefined();
    expect(back.paused).toBe(false);
    expect(progress(a, plan.id)).toEqual(before);
    expect(a.board.state().issues.filter((i) => !i.archivedAt)).toHaveLength(a.board.state().issues.length);
  });

  it('a paused plan stays paused where it lands', async () => {
    const a = computer('api', 'bob-api');
    const b = computer('api2', 'bob-api');
    const plan = await runningPlan(a);
    a.plansWork.setPaused(plan.id, true);
    await move(a, b, plan.id);
    expect(b.plans.need(plan.id).paused).toBe(true);
  });
});

describe('what Move To asks first (BLG-806)', () => {
  const check = (over: object = {}) => ({ running: [], dirty: [], paused: false, project: { name: 'bob-api' }, ...over });
  const fake = (answers: Array<Record<string, unknown>>) => {
    const calls: string[] = [];
    let i = 0;
    const from: MoveCaller = {
      async call(method: string, ...args: unknown[]) {
        calls.push(args.length && typeof args[1] === 'boolean' ? `${method}:${args[1]}` : method);
        if (method === 'plans.moveCheck') return answers[Math.min(i++, answers.length - 1)];
        if (method === 'plans.movePack') return { token: 't', chunks: 1 };
        if (method === 'plans.moveChunk') return '{}';
        return null;
      },
    };
    const to: MoveCaller = { call: async (method: string) => (calls.push(`to:${method}`), method === 'plans.moveLand' ? { id: 'pl_1' } : null) };
    return { from, to, calls };
  };
  const run = (f: ReturnType<typeof fake>, opts: { pause?: boolean; commit?: boolean } = {}) =>
    movePlan({ from: f.from, to: f.to, planId: 'pl_1', fromPlace: { name: 'This Mac' }, toPlace: { name: 'build-box' }, projectThere: async () => 'p', sleep: async () => undefined, ...opts });

  it('Move To when nothing runs; Pause and Move when something does', async () => {
    const busy = fake([check({ running: ['the agent doing “Fast”'] })]);
    const asked = await run(busy).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(MoveAsk);
    expect((asked as MoveAsk).kind).toBe('running');
    // Nothing changed: it wasn't even paused.
    expect(busy.calls).toEqual(['plans.moveCheck']);

    const waits = fake([check({ running: ['the agent doing “Fast”'] }), check({ running: ['the agent doing “Fast”'], paused: true }), check({ paused: true })]);
    await run(waits, { pause: true });
    expect(waits.calls).toEqual(['plans.moveCheck', 'plans.setPaused:true', 'plans.moveCheck', 'plans.moveCheck', 'plans.movePack', 'plans.moveChunk', 'to:plans.moveReceive', 'to:plans.moveLand', 'plans.moveDone', 'to:plans.setPaused']);
  });

  it('asks about changes not committed, and commits them only when you say so', async () => {
    const dirty = fake([check({ dirty: ['“Fast”'] })]);
    const asked = await run(dirty).catch((e: unknown) => e);
    expect((asked as MoveAsk).kind).toBe('dirty');
    expect(dirty.calls).toEqual(['plans.moveCheck']);
    const yes = fake([check({ dirty: ['“Fast”'] })]);
    await run(yes, { commit: true });
    expect(yes.calls).toContain('plans.movePack');
  });

  it('a plan that can’t move says why and changes nothing', async () => {
    const f = fake([check({ blocked: '“Fast” is merging into the plan’s branch' })]);
    await expect(run(f)).rejects.toThrow(/merging/);
    expect(f.calls).toEqual(['plans.moveCheck']);
  });

  it('waiting too long gives up and resumes it here', async () => {
    let t = 0;
    const f = fake([check({ running: ['BLG-1'] })]);
    await expect(run(f, { pause: true, ...({ waitMs: 10, now: () => (t += 6) } as object) })).rejects.toThrow(/didn’t finish in time/);
    expect(f.calls.at(-1)).toBe('plans.setPaused:false');
  });
});

describe('landing a plan (BLG-806)', () => {
  it('the pilot there starts a moved milestone’s agent from the branch it left, once', async () => {
    const b = computer('api2', 'bob-api');
    const plan = await runningPlan(b);
    b.plansWork.setPaused(plan.id, true);
    // As it lands: its first milestone was under way on beluga/old over there.
    const p = b.plans.need(plan.id);
    b.plans.movedAway(plan.id, { name: 'elsewhere', at: 1 }, { kind: 'beluga' });
    b.plans.adopt({ ...landPlan(p, { projectId: 'api2', home: p.home, ids: new Map(), branches: [], from: { name: 'This Mac', at: 2 }, by: { kind: 'beluga' } }), runs: { m1: { resumeFrom: 'beluga/old' } } });
    b.plansWork.setPaused(plan.id, false);
    for (let i = 0; i < 20 && !b.made.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(b.made[0]).toMatchObject({ base: 'beluga/old' });
    expect(b.plans.need(plan.id).runs.m1?.resumeFrom).toBeUndefined();
    expect(b.plans.need(plan.id).runs.m1?.agent).toBeDefined();
  });

  it('an open milestone’s next agent starts from the branch its agent left; checks not answered are asked again', () => {
    const plan = {
      id: 'pl_1',
      projectId: 'api',
      home: 'ws:old',
      status: 'active',
      draftRev: 1,
      autonomy: 'gated',
      maxParallel: 3,
      testsAt: 'milestone',
      paused: false,
      body: { title: 'P', goal: '', milestones: [{ id: 'm1', title: 'A', criteria: [], tasks: [{ id: 'a', title: 'x', acceptance: [], blockedBy: [], issueId: 'i_old' }] }] },
      runs: { m1: { agent: { worktree: 'w9', branch: 'beluga/a-thing', at: 1, tasks: ['a'] }, checker: 'c9', checkAsked: 5 } },
      watch: { a: { at: 1, reason: 'x', line: 'x' } },
      activity: [],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Plan;
    const landed = landPlan(plan, { projectId: 'api2', home: 'ws:new', ids: new Map([['i_old', 'i_new']]), branches: ['beluga/a-thing'], from: { name: 'This Mac', at: 9 }, by: { kind: 'beluga' } });
    expect(landed.runs.m1).toEqual({ resumeFrom: 'beluga/a-thing' });
    expect(landed.body!.milestones[0]!.tasks[0]!.issueId).toBe('i_new');
    expect(landed.watch).toBeUndefined();
    expect(landed.paused).toBe(true);
    expect(landed.home).toBe('ws:new');
  });
});
