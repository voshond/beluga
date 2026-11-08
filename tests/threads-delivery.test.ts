import { describe, expect, it } from 'vitest';
import { TERMINAL_DRIVING } from '../src/core/agent-host.js';
import { ThreadService, type ThreadServiceDeps } from '../src/core/threads/service.js';
import { Store, initialState } from '../src/core/store.js';
import type { ThreadRecord } from '../src/shared/threads.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const WAKE_MS = 15;
const settle = (ms = WAKE_MS * 4): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Wake {
  readonly channel: string;
  readonly prompt: string;
  readonly line: string;
  readonly requestId: string;
  /** What the record said when the run began. */
  readonly saved: readonly boolean[];
}

/** The service on a fake backend. `chats` stands for workspaces.json: a second service on it is a restart. */
function setup(chats = new Map<string, Workspace>(), store = freshStore()) {
  const wakes: Wake[] = [];
  const driven = new Set<string>();
  const asks: Array<{ channel: string; id: string }> = [];
  let n = chats.size;
  const add = (id: string, fields: Partial<Workspace> = {}): Workspace => {
    const ws: Workspace = { id, projectRoot: '/code/app', name: id, path: `/code/app/${id}`, kind: 'worktree', createdAt: 1, projectId: 'p1', external: false, ...fields };
    chats.set(id, ws);
    return ws;
  };
  if (!chats.has('root')) add('root');
  const deps: ThreadServiceDeps = {
    store,
    selfId: () => ME,
    projects: () => [{ id: 'p1', name: 'app', root: '/code/app', base: 'main', workspaces: [...chats.values()] }] as Project[],
    find: (id) => chats.get(id),
    setThread: (id, thread) => void chats.set(id, { ...chats.get(id)!, thread }),
    newWorktree: async (_p, name, o) => add(`t${++n}`, { name, thread: o.thread }),
    newChat: async (_p, title, o) => add(`t${++n}`, { name: title, kind: 'chat', thread: o.thread }),
    setAgent: () => undefined,
    setEffort: () => undefined,
    ask: (_prompt, channel, id) => void asks.push({ channel, id }),
    stopRun: () => undefined,
    runsAgent: () => true,
    canSteer: () => true,
    wake: (channel, prompt, line, requestId) => void wakes.push({ channel, prompt, line, requestId, saved: [...chats.values()].flatMap((w) => (w.thread?.outcome ? [w.thread.outcome.delivered] : [])) }),
    wakeMs: WAKE_MS,
    hasMacChat: () => true,
    terminalDriving: (channel) => driven.has(channel),
  };
  const service = new ThreadService(deps);
  const tools = (channel = 'ws:root') => service.forRun(channel)!;
  const start = async (task: string, channel = 'ws:root'): Promise<{ id: string; channel: string; request: string }> => {
    const answer = await tools(channel).start({ task, title: task });
    const id = /thread "([^"]+)"/.exec(answer)![1]!;
    return { id, channel: `ws:${id}`, request: asks.at(-1)!.id };
  };
  const finish = (channel: string, requestId: string, event: 'done' | 'error' = 'done', text = `Result of ${channel}`) => store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event, text, ts: Date.now(), channel });
  const parentWorks = (requestId = 'turn', channel = 'ws:root') => store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event: 'started', text: '', ts: Date.now(), channel });
  /** A person's terminal takes the chat, or gives it back: the state and the event as AgentTerminals makes them. */
  const terminal = (channel: string, open: boolean) => {
    const id = channel.slice('ws:'.length);
    if (open) {
      driven.add(channel);
      store.dispatch({ type: 'agent_term', id, state: { runtime: 'claude', label: 'Claude', since: 1 } });
    } else {
      driven.delete(channel);
      store.dispatch({ type: 'agent_term', id });
    }
  };
  return { store, service, chats, wakes, asks, add, start, finish, parentWorks, tools, terminal };
}

function freshStore(): Store {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: ME, isHost: true, home: '/home/me' });
  store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
  return store;
}

const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({ parent: 'ws:root', parentTitle: 'root', root: 'ws:root', depth: 1, task: 't', startedAt: 1, owed: [], ...over });

describe('one wake for close results', () => {
  it('3 close finishes make one wake that holds 3 results', async () => {
    const t = setup();
    const kids = [await t.start('a'), await t.start('b'), await t.start('c')];
    for (const k of kids) t.finish(k.channel, k.request);
    await waitFor(() => t.wakes.length > 0);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.channel).toBe('ws:root');
    expect(t.wakes[0]!.prompt.match(/<thread_result /g)).toHaveLength(3);
    expect(t.wakes[0]!.prompt).toContain(`Result of ${kids[1]!.channel}`);
    expect(t.wakes[0]!.line).toBe('3 child threads reported: a (done), b (done), c (done). Your agent continues with them.');
  });

  it('marks each result delivered and saves before the run', async () => {
    const t = setup();
    const k = await t.start('a');
    t.finish(k.channel, k.request);
    await waitFor(() => t.wakes.length === 1);
    expect(t.wakes[0]!.saved).toEqual([true]);
  });

  it('a later result makes a second wake with only that result', async () => {
    const t = setup();
    const a = await t.start('a');
    const b = await t.start('b');
    t.finish(a.channel, a.request);
    await waitFor(() => t.wakes.length === 1);
    t.finish(b.channel, b.request);
    await waitFor(() => t.wakes.length === 2);
    expect(t.wakes[1]!.prompt.match(/<thread_result /g)).toHaveLength(1);
    expect(t.wakes[1]!.prompt).toContain('title="b"');
  });

  it('each parent gets its own wake', async () => {
    const t = setup();
    t.add('other');
    const a = await t.start('a');
    const b = await t.start('b', 'ws:other');
    t.finish(a.channel, a.request);
    t.finish(b.channel, b.request);
    await waitFor(() => t.wakes.length === 2);
    expect(t.wakes.map((w) => w.channel).sort()).toEqual(['ws:other', 'ws:root']);
  });

  it('a failed turn and a stopped turn report their state', async () => {
    const t = setup();
    const a = await t.start('a');
    const b = await t.start('b');
    t.finish(a.channel, a.request, 'error', 'It broke');
    t.finish(b.channel, b.request, 'error', 'Stopped by you');
    await waitFor(() => t.wakes.length === 1);
    expect(t.wakes[0]!.prompt).toContain('state="failed"');
    expect(t.wakes[0]!.prompt).toContain('state="stopped"');
  });
});

describe('when the parent is busy', () => {
  it('a busy parent gets the results after its turn ends', async () => {
    const t = setup();
    const a = await t.start('a');
    t.parentWorks();
    t.finish(a.channel, a.request);
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(false);
    t.finish('ws:root', 'turn');
    await waitFor(() => t.wakes.length === 1);
    expect(t.wakes[0]!.prompt).toContain('title="a"');
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(true);
  });

  it('results that arrive during the turn share one wake', async () => {
    const t = setup();
    const a = await t.start('a');
    const b = await t.start('b');
    t.parentWorks();
    t.finish(a.channel, a.request);
    await settle();
    t.finish(b.channel, b.request);
    t.finish('ws:root', 'turn');
    await waitFor(() => t.wakes.length === 1);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt.match(/<thread_result /g)).toHaveLength(2);
  });

  it('a result that a status wait returned does not wake the parent', async () => {
    const t = setup();
    const a = await t.start('a');
    t.parentWorks();
    const wait = t.tools().status({ id: a.id, waitSec: 30 });
    t.finish(a.channel, a.request);
    expect(JSON.parse(await wait).state).toBe('done');
    t.finish('ws:root', 'turn');
    await settle();
    expect(t.wakes).toEqual([]);
  });
});

describe('what does not wake', () => {
  it('a person’s turn does not wake', async () => {
    const t = setup();
    const a = await t.start('a');
    t.finish(a.channel, a.request);
    await waitFor(() => t.wakes.length === 1);
    t.finish(a.channel, 'a-person-asked', 'done', 'For the person');
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.chats.get(a.id)!.thread!.outcome).toMatchObject({ summary: 'For the person', delivered: true });
  });

  it('a stop that the parent asked for does not wake it', async () => {
    const t = setup();
    const a = await t.start('a');
    t.tools().stop({ id: a.id });
    t.finish(a.channel, a.request, 'error', 'Stopped by you');
    await settle();
    expect(t.wakes).toEqual([]);
  });

  it('a queued message holds the report until its turn ends too', async () => {
    const t = setup();
    const a = await t.start('a');
    t.tools().message({ id: a.id, text: 'more' });
    t.finish(a.channel, a.request);
    await settle();
    expect(t.wakes).toEqual([]);
    t.finish(a.channel, t.asks.at(-1)!.id, 'done', 'Second answer');
    await waitFor(() => t.wakes.length === 1);
    expect(t.wakes[0]!.prompt).toContain('Second answer');
  });
});

describe('a stopped parent thread', () => {
  it('holds a child’s result, and a person’s new turn there releases it', async () => {
    const t = setup();
    const child = await t.start('child');
    const grand = await t.start('grand', child.channel);
    t.finish(child.channel, child.request, 'error', 'Stopped by you');
    await waitFor(() => t.wakes.length === 1);
    t.finish(grand.channel, grand.request);
    await settle();
    expect(t.wakes).toHaveLength(1);
    t.finish(child.channel, 'a-person-asked', 'done', 'Carried on');
    await waitFor(() => t.wakes.length === 2);
    expect(t.wakes[1]!.channel).toBe(child.channel);
    expect(t.chats.get(child.id)!.thread!.stopped).toBeUndefined();
  });
});

describe('a chain of threads', () => {
  it('a wake of a child thread is owed to its own parent', async () => {
    const t = setup();
    const child = await t.start('child');
    const grand = await t.start('grand', child.channel);
    t.finish(child.channel, child.request, 'done', 'I wait for grand');
    await waitFor(() => t.wakes.length === 1);
    t.finish(grand.channel, grand.request);
    await waitFor(() => t.wakes.length === 2);
    const wake = t.wakes[1]!;
    expect(wake.channel).toBe(child.channel);
    expect(t.chats.get(child.id)!.thread!.owed).toEqual([wake.requestId]);
    t.finish(child.channel, wake.requestId, 'done', 'Grand finished, all done');
    await waitFor(() => t.wakes.length === 3);
    expect(t.wakes[2]!.channel).toBe('ws:root');
    expect(t.wakes[2]!.prompt).toContain('Grand finished, all done');
  });
});

describe('a restart', () => {
  it('a restart after delivery does not deliver again', async () => {
    const t = setup();
    const a = await t.start('a');
    t.finish(a.channel, a.request);
    await waitFor(() => t.wakes.length === 1);
    t.service.stop();
    const again = setup(t.chats);
    again.service.recover();
    await settle();
    expect(again.wakes).toEqual([]);
  });

  it('a restart before delivery delivers once', async () => {
    const chats = new Map<string, Workspace>();
    const t = setup(chats);
    const a = await t.start('a');
    t.parentWorks();
    t.finish(a.channel, a.request);
    await settle();
    t.service.stop();
    const again = setup(chats);
    again.service.recover();
    await waitFor(() => again.wakes.length === 1);
    expect(again.wakes[0]!.prompt).toContain('state="done"');
    again.service.stop();
    const third = setup(chats);
    third.service.recover();
    await settle();
    expect(third.wakes).toEqual([]);
  });

  it('a restart during a child’s turn reports interrupted once and starts nothing', async () => {
    const chats = new Map<string, Workspace>();
    const t = setup(chats);
    const a = await t.start('a');
    t.service.stop();
    const asksBefore = t.asks.length;
    const again = setup(chats);
    expect(JSON.parse(await again.tools().status({ id: a.id })).state).toBe('interrupted');
    again.service.recover();
    await waitFor(() => again.wakes.length === 1);
    await settle();
    expect(again.wakes).toHaveLength(1);
    expect(again.wakes[0]!.prompt).toContain('state="interrupted"');
    expect(again.asks).toEqual([]);
    expect(t.asks).toHaveLength(asksBefore);
    expect(chats.get(a.id)!.thread).toMatchObject({ owed: [], outcome: { state: 'interrupted', delivered: true } });
    again.service.stop();
    const third = setup(chats);
    third.service.recover();
    await settle();
    expect(third.wakes).toEqual([]);
  });
});

describe('a person’s terminal drives the parent', () => {
  it('while the terminal drives the parent, no result is marked delivered and no run starts', async () => {
    const t = setup();
    const a = await t.start('a');
    t.terminal('ws:root', true);
    t.finish(a.channel, a.request);
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(a.id)!.thread!.outcome).toMatchObject({ state: 'done', delivered: false });
  });

  it('when the terminal stops driving, one wake holds all held results, and no result repeats', async () => {
    const t = setup();
    const a = await t.start('a');
    const b = await t.start('b');
    t.terminal('ws:root', true);
    t.finish(a.channel, a.request);
    await settle();
    t.finish(b.channel, b.request);
    await settle();
    expect(t.wakes).toEqual([]);
    t.terminal('ws:root', false);
    await waitFor(() => t.wakes.length === 1);
    expect(t.wakes[0]!.prompt.match(/<thread_result /g)).toHaveLength(2);
    expect(t.wakes[0]!.saved).toEqual([true, true]);
    t.terminal('ws:root', true);
    t.terminal('ws:root', false);
    await settle();
    expect(t.wakes).toHaveLength(1);
  });

  it('another chat’s terminal releases nothing here', async () => {
    const t = setup();
    t.add('other');
    const a = await t.start('a');
    t.terminal('ws:root', true);
    t.finish(a.channel, a.request);
    await settle();
    t.terminal('ws:other', true);
    t.terminal('ws:other', false);
    await settle();
    expect(t.wakes).toEqual([]);
  });

  it('a thread_status read while held still returns the results and counts as delivered', async () => {
    const t = setup();
    const a = await t.start('a');
    const b = await t.start('b');
    t.terminal('ws:root', true);
    t.finish(a.channel, a.request);
    t.finish(b.channel, b.request, 'done', 'Second result');
    await settle();
    expect(JSON.parse(await t.tools().status({ id: a.id }))).toMatchObject({ state: 'done', answer: `Result of ${a.channel}` });
    const list = JSON.parse(await t.tools().status({})) as { threads: Array<{ id: string; answer?: string }> };
    expect(list.threads.find((x) => x.id === b.id)?.answer).toBe('Second result');
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(true);
    expect(t.chats.get(b.id)!.thread!.outcome?.delivered).toBe(true);
    t.terminal('ws:root', false);
    await settle();
    expect(t.wakes).toEqual([]);
  });

  it('a read while nothing holds the parent still does not claim', async () => {
    const t = setup();
    const a = await t.start('a');
    t.parentWorks();
    t.finish(a.channel, a.request);
    await t.tools().status({ id: a.id });
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(false);
  });

  it('a terminal that opens while the wake waits gets the results held again, and they come once', async () => {
    const t = setup();
    const a = await t.start('a');
    t.finish(a.channel, a.request);
    await waitFor(() => t.wakes.length === 1);
    t.terminal('ws:root', true);
    t.finish('ws:root', t.wakes[0]!.requestId, 'error', TERMINAL_DRIVING);
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(false);
    await settle();
    expect(t.wakes).toHaveLength(1);
    t.terminal('ws:root', false);
    await waitFor(() => t.wakes.length === 2);
    t.finish('ws:root', t.wakes[1]!.requestId);
    await settle();
    expect(t.wakes).toHaveLength(2);
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(true);
  });
});

describe('where the parent went', () => {
  it('an archived parent holds its reports and wakes once when it is restored', async () => {
    const t = setup();
    const a = await t.start('a');
    t.chats.set('root', { ...t.chats.get('root')!, archived: true });
    t.finish(a.channel, a.request);
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(false);
    t.chats.set('root', { ...t.chats.get('root')!, archived: false });
    t.store.dispatch({ type: 'projects', projects: [] });
    await waitFor(() => t.wakes.length === 1);
    t.store.dispatch({ type: 'projects', projects: [] });
    await settle();
    expect(t.wakes).toHaveLength(1);
  });

  it('a gone parent causes no run and no error, and the result stays on the child', async () => {
    const t = setup();
    const a = await t.start('a');
    t.chats.delete('root');
    expect(() => t.finish(a.channel, a.request)).not.toThrow();
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(a.id)!.thread!.outcome).toMatchObject({ summary: `Result of ${a.channel}`, delivered: false });
  });

  it('a gone parent causes no run on a restart either', async () => {
    const t = setup();
    t.add('orphan', { thread: thread({ parent: 'ws:nobody', outcome: { state: 'done', summary: 's', at: 1, delivered: false } }) });
    t.service.recover();
    await settle();
    expect(t.wakes).toEqual([]);
  });
});

describe('BLG-334: with agentThreads off, no parent wakes for a thread result', () => {
  it('keeps each result on the child, undelivered, and delivers it once in one wake when the switch is on again', async () => {
    const t = setup();
    const a = await t.start('a');
    const b = await t.start('b');
    t.store.dispatch({ type: 'prefs', prefs: { agentThreads: false } });
    t.finish(a.channel, a.request);
    t.finish(b.channel, b.request);
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(a.id)!.thread!.outcome).toMatchObject({ summary: `Result of ${a.channel}`, delivered: false });
    expect(t.chats.get(b.id)!.thread!.outcome?.delivered).toBe(false);
    t.store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
    await waitFor(() => t.wakes.length === 1);
    await settle();
    t.store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt.match(/<thread_result /g)).toHaveLength(2);
    expect(t.chats.get(a.id)!.thread!.outcome?.delivered).toBe(true);
  });

  it('a person’s Stop still stops the threads under the chat', async () => {
    const t = setup();
    const a = await t.start('a');
    t.store.dispatch({ type: 'prefs', prefs: { agentThreads: false } });
    expect(t.service.stopTree('ws:root')).toBe(1);
    expect(t.chats.get(a.id)!.thread!.stopped?.by).toBe('person');
  });
});
