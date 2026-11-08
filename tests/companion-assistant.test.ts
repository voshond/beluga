import { describe, expect, it } from 'vitest';
import { RefTable } from '../src/companion/files.js';
import { macViewFor } from '../src/companion/open-on-mac.js';
import { COMPANION_PROTO, ConvView, HomeView, SINCE, Topic, WorkView } from '../src/companion/protocol.js';
import { PHONE } from '../src/companion/coverage.js';
import { PhoneCalls } from '../src/companion/calls.js';
import { type ViewContext, convTopic, homeView, planPageView, viewOf, workView } from '../src/companion/views.js';
import type { Plan } from '../src/core/plans/model.js';
import { PlanView } from '../src/companion/protocol.js';
import { type Action, Store, channelOf, initialState, shownChannel } from '../src/core/store.js';
import { API } from '../src/ipc/api.js';
import { ASSISTANT_CHANNEL } from '../src/shared/assistant.js';

/**
 * "Your Mac" on the phone (BLG-47): its topic, its view (you can write in it, its outputs), Home's
 * entry, and that it isn't a project in Work. Asking in a project (BLG-69): a worktree, a plan or a
 * question. A project has no main conversation of its own (BLG-70).
 */

const ME = 'me';
const T0 = 1_760_000_000_000;
const worktree = (id: string, name: string, kind = 'worktree') => ({ id, projectRoot: '/p', projectId: 'p1', name, path: kind === 'main' ? '/p' : `/p/.w/${id}`, kind, createdAt: T0, external: false });

function state() {
  const store = new Store(initialState('room'));
  const run = (a: Action): void => store.dispatch(a);
  run({ type: 'identity', selfId: ME, isHost: true, home: '/Users/k' });
  run({ type: 'projects', projects: [{ id: 'p1', name: 'beluga', root: '/p', base: 'main', workspaces: [worktree('p1:main', 'beluga', 'main'), worktree('w1', 'login')] }] as never });
  run({ type: 'chat', id: 'c1', from: ME, text: 'What is using my CPU?', ts: T0, byAgent: false, channel: ASSISTANT_CHANNEL });
  run({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'started', text: '', ts: T0 + 1, channel: ASSISTANT_CHANNEL, itemId: 'i1' });
  run({ type: 'agent_event', owner: ME, requestId: 'r1', requester: ME, event: 'tool', text: 'Bash ps -Ao pid,pcpu', ts: T0 + 2, channel: ASSISTANT_CHANNEL, itemId: 'i1' });
  return store;
}

const ctx = (): ViewContext => ({
  refs: new RefTable(() => 'ref00001'),
  mac: { name: 'Mac', version: '1' },
  outputs: (channel) => (channel === ASSISTANT_CHANNEL ? [{ path: '/Users/k/.beluga/assistant/work/.beluga/scratch/top.txt', size: 40, ts: T0 + 2, cwd: '/Users/k/.beluga/assistant/work' }] : []),
});

describe('Your Mac on the phone', () => {
  it('has its topic, gated on 1.5', () => {
    expect(convTopic(ASSISTANT_CHANNEL)).toBe('conv:mac:assistant');
    expect(Topic.safeParse('conv:mac:assistant').success).toBe(true);
    expect(SINCE.assistant).toBe(5);
    expect(COMPANION_PROTO.minor).toBeGreaterThanOrEqual(SINCE.assistant);
  });

  it('its conversation: you can write in it, it works live, its scratch files are its outputs', () => {
    const s = state().getState();
    const view = viewOf(s, ctx(), 'conv:mac:assistant') as ConvView;
    expect(ConvView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ title: 'Your Mac', canSend: true, working: true });
    expect(view.outputs?.map((o) => o.name)).toEqual(['top.txt']);
    expect(view.turns.at(-1)?.live ?? view.turns.at(-1)?.step).toBeTruthy();
  });

  it('Home carries it for "Ask your Mac" (and as running while it works); Work doesn’t list it', () => {
    const s = state().getState();
    const home = homeView(s, ctx());
    expect(HomeView.safeParse(home).success).toBe(true);
    expect(home.assistant).toMatchObject({ topic: 'conv:mac:assistant', title: 'Your Mac', status: 'working' });
    expect(home.running.map((r) => r.topic)).toContain('conv:mac:assistant');
    const work = workView(s, ctx());
    expect(WorkView.safeParse(work).success).toBe(true);
    expect(work.projects.flatMap((p) => p.conversations.map((c) => c.topic))).not.toContain('conv:mac:assistant');
  });

  it('Home lists all its chats in tab order (1.14); the phone starts and deletes one, the Mac keeps which tab is open', () => {
    const store = state();
    store.dispatch({ type: 'assistant_chats', assistant: { chats: [{ id: 'main', channel: ASSISTANT_CHANNEL, createdAt: T0 }, { id: 'b2', channel: `${ASSISTANT_CHANNEL}:b2`, createdAt: T0 + 5 }], active: 'b2' } });
    const home = homeView(store.getState(), ctx());
    expect(HomeView.safeParse(home).success).toBe(true);
    expect(home.macChats?.map((c) => [c.topic, c.title])).toEqual([
      ['conv:mac:assistant', 'What is using my CPU?'],
      ['conv:mac:assistant:b2', 'New chat'],
    ]);
    expect(home.assistant?.topic).toBe('conv:mac:assistant:b2');
    expect(SINCE.macChats).toBeLessThanOrEqual(COMPANION_PROTO.minor);
    expect([PHONE['assistant.newChat'], PHONE['assistant.deleteChat'], PHONE['assistant.openChat']]).toEqual(['phone', 'phone', 'mac']);
    expect(Object.keys(PhoneCalls)).toEqual(expect.arrayContaining(['assistant.newChat', 'assistant.deleteChat']));
  });

  it('opens on the Mac as its sidebar row', () => {
    const s = state().getState();
    expect(macViewFor(s, { topic: 'conv:mac:assistant' })).toEqual({ kind: 'assistant' });
    expect(channelOf({ kind: 'assistant' })).toBe(ASSISTANT_CHANNEL);
    expect(shownChannel({ kind: 'assistant' })).toBe(ASSISTANT_CHANNEL);
  });
});

describe('no main conversation in a project (BLG-70)', () => {
  it('the main checkout is no conversation: not in Work, not on Home, nothing to send to', () => {
    const store = state();
    const s0 = store.getState();
    expect(workView(s0, ctx()).projects.flatMap((p) => p.conversations.map((c) => c.topic))).toEqual(['conv:ws:w1']);
    store.dispatch({ type: 'agent_event', owner: ME, requestId: 'r2', requester: ME, event: 'started', text: '', ts: T0 + 5, channel: 'ws:p1:main', itemId: 'i2' });
    const s = store.getState();
    expect(homeView(s, ctx()).running.map((r) => r.topic)).not.toContain('conv:ws:p1:main');
    expect((viewOf(s, ctx(), 'conv:ws:p1:main') as ConvView).canSend).toBe(false);
    expect(workView(s, ctx()).projects.flatMap((p) => p.conversations.map((c) => c.topic))).toEqual(['conv:ws:w1']);
  });

  it('a main conversation that became a chat is listed as a normal chat, and Open on your Mac goes there', () => {
    const store = state();
    const s0 = store.getState();
    const projects = s0.projects.map((p) =>
      p.id === 'p1'
        ? { ...p, workspaces: [...p.workspaces.map((w) => (w.kind === 'main' ? { ...w, movedTo: 'chat-old' } : w)), { id: 'chat-old', projectRoot: p.root, name: 'Where are the routes?', path: p.root, kind: 'chat' as const, createdAt: T0 - 10, projectId: p.id, external: false, askOnly: true }] }
        : p,
    );
    store.dispatch({ type: 'projects', projects, groups: s0.projectGroups, order: s0.projectOrder, hidden: [] });
    const s = store.getState();
    const listed = workView(s, ctx()).projects.flatMap((p) => p.conversations.map((c) => [c.topic, c.title]));
    expect(listed).toContainEqual(['conv:ws:chat-old', 'Where are the routes?']);
    expect(listed.map(([t]) => t)).not.toContain('conv:ws:p1:main');
    expect(macViewFor(s, { topic: 'conv:ws:p1:main' })).toEqual({ kind: 'workspace', id: 'chat-old', tab: 'chat' });
  });

  it('Open on your Mac for a main checkout with no old conversation opens the project’s home', () => {
    expect(macViewFor(state().getState(), { topic: 'conv:ws:p1:main' })).toEqual({ kind: 'project', id: 'p1' });
  });
});

describe('asking in a project from the phone (BLG-69)', () => {
  it('a new worktree (with plan mode) and a plan are the Mac’s own calls, on the phone’s list', () => {
    expect(PHONE['workspaces.startWorktree']).toBe('phone');
    expect(PHONE['plans.create']).toBe('phone');
    expect(Object.keys(PhoneCalls)).toEqual(expect.arrayContaining(['workspaces.startWorktree', 'plans.create', 'companion.ask']));
    expect(API['workspaces.startWorktree'].args.safeParse(['p1', 'Fix the login bug', { plan: true, quiet: true }]).success).toBe(true);
    expect(API['plans.create'].args.safeParse([{ projectId: 'p1', goal: 'Auth' }]).success).toBe(true);
    expect(SINCE.askModes).toBe(5);
  });
});

describe('Advanced Planning on the phone (BLG-69)', () => {
  it('a draft reads whole: milestones with what they wait on, tasks with their blockers and acceptance, and how it runs', () => {
    const store = state();
    const plan = {
      id: 'pl_pk',
      projectId: 'p1',
      home: 'ws:w1',
      status: 'draft',
      draft: {
        title: 'Passkeys',
        goal: 'Sign in with a passkey',
        milestones: [
          { id: 'm1', title: 'Server', criteria: ['End to end'], tasks: [{ id: 'api', title: 'Registration API', goal: 'Endpoints', acceptance: ['Challenges expire'], blockedBy: [] }, { id: 'signin', title: 'Sign-in', acceptance: [], blockedBy: ['api'] }] },
          { id: 'm2', title: 'App', criteria: [], dependsOn: ['m1'], tasks: [{ id: 'btn', title: 'The button', acceptance: [], blockedBy: ['signin'] }] },
        ],
      },
      draftRev: 1,
      autonomy: 'gated',
      maxParallel: 3,
      testsAt: 'milestone',
      paused: false,
      runs: {},
      activity: [],
      createdAt: T0,
      updatedAt: T0,
    } as unknown as Plan;
    store.dispatch({ type: 'plans_init', state: { enabled: true, style: '', plans: [plan] } });
    const view = planPageView(store.getState(), 'pl_pk')!;
    expect(PlanView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ autonomy: 'gated', parallel: 3, running: 0 });
    expect(view.milestones[0]!.tasks[0]).toMatchObject({ id: 'api', goal: 'Endpoints', acceptance: ['Challenges expire'] });
    expect(view.milestones[0]!.tasks[1]!.blockedBy).toEqual(['api']);
    expect(view.milestones[1]!.dependsOn).toEqual(['m1']);
    // Approve and Discard wait on its page (and Home) as a needs-you item.
    expect(view.needsYou.map((n) => n.actions.map((a) => a.method))).toEqual([['plans.approve', 'plans.verify', 'plans.discard']]);
    expect(PHONE['plans.setAutonomy']).toBe('phone');
    expect(Object.keys(PhoneCalls)).toContain('plans.setAutonomy');
  });
});
