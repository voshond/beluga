import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { PlansWork } from '../src/core/plans/work.js';
import { stepAgent } from '../src/core/sentinel/model.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController, WorktreeEvent } from '../src/core/workspace-controller.js';
import { BOARD_API } from '../src/ipc/board-api.js';
import { PLANS_API } from '../src/ipc/plans-api.js';
import type { AgentRef } from '../src/protocol.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { agentFields, sharedAgent, stepAgentChoice, withAgent } from '../packages/mac/src/sentinel/sentinel-model.js';
import { fakePlaces, setup as sentinelSetup, until } from './sentinel-fakes.js';

/** BLG-497: tasks, plans and Sentinel's agent steps each pick the agent (and model) that does them. */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const LOCAL: AgentRef = { runtime: 'local', label: 'Local model', model: 'qwen3' };

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree'): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api', [ws('main', 'api', 'bob-api', 'chat')])] });
  const listeners: Array<(e: WorktreeEvent) => void> = [];
  const made: Array<{ name: string; agent?: AgentRef }> = [];
  let n = 0;
  const controller = {
    onWorktree: (l: (e: WorktreeEvent) => void) => {
      listeners.push(l);
      return () => undefined;
    },
    newWorktree: async (projectId: string, name: string, o: { agent?: AgentRef } = {}) => {
      made.push({ name, ...(o.agent ? { agent: o.agent } : {}) });
      const w = ws(`w${++n}`, projectId, name);
      store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
      listeners.forEach((l) => l({ kind: 'created', ws: w }));
      return w;
    },
  } as unknown as WorkspaceController;
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const work = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: () => undefined });
  return { store, board, work, controller, made };
}

describe('a task picks its agent (BLG-497)', () => {
  it('kept on the task, and its worktree runs it when the task starts', async () => {
    const t = setup();
    const task = t.board.create({ projectId: 'api', title: 'Port the parser', agent: CODEX }, t.work.me());
    expect(task.agent).toEqual(CODEX);
    await t.work.start(task.id, { claude: true });
    expect(t.made).toEqual([{ name: expect.any(String), agent: CODEX }]);
  });

  it('a task with none follows your default (the worktree gets no agent of its own); Start can name one', async () => {
    const t = setup();
    const plain = t.board.create({ projectId: 'api', title: 'Tidy logs' }, t.work.me());
    expect(plain.agent).toBeUndefined();
    await t.work.start(plain.id, { claude: true });
    expect(t.made[0]!.agent).toBeUndefined();
    const other = t.board.create({ projectId: 'api', title: 'Bench', agent: CODEX }, t.work.me());
    await t.work.start(other.id, { claude: true, agent: LOCAL });
    expect(t.made[1]!.agent).toEqual(LOCAL);
  });

  it('the API takes it as an additive, optional field', () => {
    const args = BOARD_API['board.create'].args;
    expect(args.parse([{ projectId: 'api', title: 'x', agent: CODEX }])[0].agent).toEqual(CODEX);
    expect(args.parse([{ projectId: 'api', title: 'x' }])[0].agent).toBeUndefined();
    expect(() => args.parse([{ projectId: 'api', title: 'x', agent: { runtime: 'Not ok', label: 'x' } }])).toThrow();
  });
});

const BODY: BodyInput = {
  title: 'Parser',
  goal: 'A faster parser.',
  milestones: [{ id: 'm1', title: 'Fast', criteria: ['fast'], tasks: [{ id: 'a', title: 'Lexer' }, { id: 'b', title: 'Grammar', blockedBy: ['a'] }] }],
};

function plansSetup(workers: 'milestone' | 'task') {
  const t = setup();
  const plans = new Plans({ store: t.store, dir: null });
  const work = new PlansWork({ store: t.store, plans, board: t.work, controller: t.controller, git: null, askClaude: () => 'ask', intend: () => undefined, delayMs: 0, workers });
  return { ...t, plans, plansWork: work };
}

describe('a plan picks who works it (BLG-497)', () => {
  it('a milestone’s one worktree runs the plan’s agent', async () => {
    const t = plansSetup('milestone');
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot', agent: CODEX }, t.work.myClaude());
    expect(t.plans.need(plan.id).agent).toEqual(CODEX);
    t.plansWork.forRun('ws:main', 'p-me')!.tools!.write(BODY);
    t.plansWork.approve(plan.id);
    await tick(10);
    expect(t.made).toEqual([{ name: expect.any(String), agent: CODEX }]);
  });

  it('task by task: a task’s own agent beats the plan’s; none, and the plan has none: your default', async () => {
    const t = plansSetup('task');
    const plan = t.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot', agent: CODEX }, t.work.myClaude());
    t.plansWork.forRun('ws:main', 'p-me')!.tools!.write({ ...BODY, milestones: [{ ...BODY.milestones[0]!, tasks: [{ id: 'a', title: 'Lexer' }] }] });
    t.plansWork.approve(plan.id);
    await tick(10);
    expect(t.made).toEqual([{ name: expect.any(String), agent: CODEX }]);

    const u = plansSetup('task');
    const none = u.plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'autopilot' }, u.work.myClaude());
    u.plansWork.forRun('ws:main', 'p-me')!.tools!.write({ ...BODY, milestones: [{ ...BODY.milestones[0]!, tasks: [{ id: 'a', title: 'Lexer' }] }] });
    u.plansWork.approve(none.id);
    await tick(10);
    expect(u.made).toHaveLength(1);
    expect(u.made[0]!.agent).toBeUndefined();
  });

  it('plans.create takes it as an additive, optional field', () => {
    const args = PLANS_API['plans.create'].args;
    expect(args.parse([{ projectId: 'api', goal: 'g', agent: LOCAL }])[0].agent).toEqual(LOCAL);
    expect(args.parse([{ projectId: 'api', goal: 'g' }])[0].agent).toBeUndefined();
  });
});

describe('Sentinel’s Ask Your Agent step picks its agent and model (BLG-497)', () => {
  it('stepAgent: none is your default; a runtime with its label and model; an older model-only step is Claude’s', () => {
    expect(stepAgent({})).toBeUndefined();
    expect(stepAgent({ runtime: 'codex', model: 'gpt-5.5' })).toEqual(CODEX);
    expect(stepAgent({ runtime: 'local' })).toEqual({ runtime: 'local', label: 'Local model' });
    expect(stepAgent({ model: 'opus' })).toEqual({ runtime: 'claude', label: 'Claude', model: 'opus' });
  });

  it('the run’s chat runs the step’s agent; a step without one gets your default back', async () => {
    const set: Array<[string, AgentRef | undefined]> = [];
    const p = fakePlaces();
    const s = sentinelSetup({ reply: () => 'ok', places: { ...p.places, setAgent: (id, agent) => void set.push([id, agent]) } });
    const made = s.sentinels.create({
      name: 'Two agents',
      projectId: 'api',
      steps: [
        { kind: 'claude', name: 'Codex looks', where: 'project', prompt: 'Look', runtime: 'codex', model: 'gpt-5.5' },
        { kind: 'claude', name: 'Default sums up', where: 'project', prompt: 'Sum up' },
      ],
    });
    expect(made.steps[0]).toMatchObject({ runtime: 'codex', model: 'gpt-5.5' });
    // No sentinel model in Settings: a step without an agent follows your default (sentinel-effort.test.ts has the model).
    s.store.dispatch({ type: 'prefs', prefs: { sentinelModel: '' } });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => !['queued', 'running'].includes(s.sentinels.runGet(run.id).run.state));
    // One chat for both (the project place is shared), its agent set before each ask.
    expect(set).toEqual([
      ['c1', CODEX],
      ['c1', undefined],
    ]);
  });

  it('the Mac’s pop-up values: your default, a runtime and model, every step at once', () => {
    expect(stepAgentChoice({})).toBe('');
    expect(stepAgentChoice({ runtime: 'codex', model: 'gpt-5.5' })).toBe('codex:gpt-5.5');
    expect(stepAgentChoice({ model: 'opus' })).toBe('claude:opus');
    expect(agentFields('')).toEqual({ runtime: undefined, model: undefined });
    expect(agentFields('local:')).toEqual({ runtime: 'local', model: undefined });
    const steps = [
      { id: 's1', kind: 'claude' as const, name: 'a', prompt: 'p', where: 'project' as const, model: 'opus' },
      { id: 's2', kind: 'notify' as const, name: 'n', phone: false },
      { id: 's3', kind: 'claude' as const, name: 'b', prompt: 'p', where: 'project' as const },
    ];
    expect(sharedAgent(steps)).toBeUndefined();
    const all = withAgent(steps, 'codex:gpt-5.5');
    expect(sharedAgent(all)).toBe('codex:gpt-5.5');
    expect(all[1]).toEqual(steps[1]);
    expect(sharedAgent(withAgent(all, ''))).toBe('');
    expect(withAgent(all, '')[0]).not.toHaveProperty('runtime');
  });
});
