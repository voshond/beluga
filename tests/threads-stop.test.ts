import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { launchThreads, threadsOf } from '../src/core/threads/launch.js';
import { ThreadService, type ThreadServiceDeps } from '../src/core/threads/service.js';
import { Store, initialState } from '../src/core/store.js';
import { phoneMay } from '../src/companion/coverage.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

const ME = 'me';
const WAKE_MS = 15;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, WAKE_MS * 4));
const idOf = (answer: string): string => /thread "([^"]+)"/.exec(answer)![1]!;

function freshStore(): Store {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: ME, isHost: true, home: '/home/me' });
  store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
  return store;
}

/** The service on a fake backend. `chats` stands for workspaces.json: a second service on it is a restart. */
function setup(over: Partial<ThreadServiceDeps> = {}, chats = new Map<string, Workspace>()) {
  const store = freshStore();
  const asks: Array<{ channel: string; id: string }> = [];
  const stops: string[] = [];
  const wakes: Array<{ channel: string; prompt: string }> = [];
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
    stopRun: (channel) => void stops.push(channel),
    runsAgent: () => true,
    canSteer: () => true,
    wake: (channel, prompt) => void wakes.push({ channel, prompt }),
    wakeMs: WAKE_MS,
    hasMacChat: () => true,
    terminalDriving: () => false,
    ...over,
  };
  const service = new ThreadService(deps);
  const tools = (channel = 'ws:root') => service.forRun(channel)!;
  const start = async (task: string, channel = 'ws:root'): Promise<{ id: string; channel: string; request: string }> => {
    const id = idOf(await tools(channel).start({ task, title: task }));
    return { id, channel: `ws:${id}`, request: asks.at(-1)!.id };
  };
  const finish = (channel: string, requestId: string, event: 'done' | 'error' = 'done', text = 'Stopped by you') => store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event, text, ts: Date.now(), channel });
  return { store, service, chats, asks, stops, wakes, tools, start, finish };
}

describe('a person’s Stop on a parent', () => {
  it('stops the child and the grandchild, depth first, and no wake follows', async () => {
    const t = setup();
    const child = await t.start('child');
    const grand = await t.start('grand', child.channel);
    expect(t.service.stopTree('ws:root')).toBe(2);
    expect(t.stops).toEqual([grand.channel, child.channel]);
    for (const c of [child, grand]) {
      expect(t.chats.get(c.id)!.thread!.stopped?.by).toBe('person');
      t.finish(c.channel, c.request, 'error');
      expect(t.chats.get(c.id)!.thread!.outcome).toMatchObject({ state: 'stopped', delivered: true });
    }
    await settle();
    expect(t.wakes).toEqual([]);
  });

  it('a result still on its way does not wake the parent, and thread_status still has it', async () => {
    const t = setup();
    const done = await t.start('done');
    const running = await t.start('running');
    t.finish(done.channel, done.request, 'done', 'All green.');
    t.service.stopTree('ws:root');
    t.finish(running.channel, running.request, 'error');
    await settle();
    expect(t.wakes).toEqual([]);
    expect(JSON.parse(await t.tools().status({ id: done.id }))).toMatchObject({ state: 'done', answer: 'All green.' });
  });

  it('a turn that ended by itself as the Stop landed does not wake the parent', async () => {
    const t = setup();
    const child = await t.start('child');
    t.service.stopTree('ws:root');
    t.finish(child.channel, child.request, 'done', 'Finished just in time.');
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(child.id)!.thread!.outcome).toMatchObject({ state: 'done', delivered: true });
  });

  it('a thread with no run behind it gets its outcome now, and one that ended stays as it ended', async () => {
    const t = setup();
    const ended = await t.start('ended');
    t.finish(ended.channel, ended.request, 'done', 'Fine.');
    expect(t.service.stopTree('ws:root')).toBe(0);
    expect(t.stops).toEqual([]);
    expect(t.chats.get(ended.id)!.thread!.stopped).toBeUndefined();
    expect(t.chats.get(ended.id)!.thread!.outcome?.state).toBe('done');
  });

  it('a failure on one thread does not end the walk', async () => {
    const stops: string[] = [];
    const t = setup({
      stopRun: (channel) => {
        stops.push(channel);
        if (stops.length === 1) throw new Error('no');
      },
    });
    const a = await t.start('a');
    const b = await t.start('b');
    expect(t.service.stopTree('ws:root')).toBe(1);
    expect(stops).toEqual([a.channel, b.channel]);
  });

  it('a restart in the middle does not wake the parent either', async () => {
    const chats = new Map<string, Workspace>();
    const t = setup({}, chats);
    const child = await t.start('child');
    t.service.stopTree('ws:root');
    t.service.stop();
    const again = setup({}, chats);
    again.service.recover();
    await settle();
    expect(again.wakes).toEqual([]);
    expect(chats.get(child.id)!.thread!.outcome).toMatchObject({ state: 'interrupted', delivered: true });
    again.service.stop();
  });

  it('a person’s Stop in the child alone still reports to the parent', async () => {
    const t = setup();
    const child = await t.start('child');
    t.finish(child.channel, child.request, 'error');
    await waitFor(() => t.wakes.length === 1);
    expect(t.wakes[0]!.prompt).toContain('state="stopped"');
  });
});

describe('a run that the Stop reached', () => {
  it('cannot start a thread, even when the call lands late', async () => {
    const t = setup();
    const running = t.tools();
    t.service.stopTree('ws:root');
    await expect(running.start({ task: 'late' })).rejects.toThrow(/stopped/i);
    expect(t.asks).toEqual([]);
  });

  it('a stopped child’s run cannot start one either', async () => {
    const t = setup();
    const child = await t.start('child');
    const running = t.tools(child.channel);
    t.service.stopTree('ws:root');
    await expect(running.start({ task: 'late' })).rejects.toThrow(/stopped/i);
    expect(t.asks).toHaveLength(1);
  });

  it('cannot carry a stopped thread on with a message', async () => {
    const t = setup();
    const child = await t.start('child');
    const running = t.tools();
    t.service.stopTree('ws:root');
    expect(() => running.message({ id: child.id, text: 'go on' })).toThrow(/stopped/i);
    expect(t.chats.get(child.id)!.thread!.stopped?.by).toBe('person');
  });

  it('a start still making its chat when the Stop lands sends nothing, and the child shows stopped', async () => {
    let made: ((ws: Workspace | undefined) => void) | undefined;
    const t = setup({ newWorktree: (_p, name, o) => new Promise((resolve) => void (made = (ws) => resolve(ws && t.chats.set('late', { ...ws, id: 'late', name, thread: o.thread }).get('late')))) });
    const going = t.tools().start({ task: 'slow', title: 'slow' });
    await waitFor(() => made !== undefined);
    t.service.stopTree('ws:root');
    made!({ id: 'late', projectRoot: '/code/app', name: 'slow', path: '/code/app/late', kind: 'worktree', createdAt: 1, projectId: 'p1', external: false });
    await expect(going).rejects.toThrow(/stopped/i);
    expect(t.asks).toEqual([]);
    expect(t.chats.get('late')!.thread).toMatchObject({ owed: [], stopped: { by: 'person' }, outcome: { state: 'stopped', delivered: true } });
    await settle();
    expect(t.wakes).toEqual([]);
  });

  it('the next run in that chat can start threads again', async () => {
    const t = setup();
    t.service.stopTree('ws:root');
    expect(idOf(await t.tools().start({ task: 'new work' }))).toBeTruthy();
  });

  it('the start limits free up', async () => {
    const t = setup();
    t.store.dispatch({ type: 'prefs', prefs: { threadLimits: { depth: 3, treeRunning: 1, treeLive: 30, macRunning: 16 } } });
    const child = await t.start('child');
    await expect(t.tools().start({ task: 'second' })).rejects.toThrow(/limit/);
    t.service.stopTree('ws:root');
    t.finish(child.channel, child.request, 'error');
    expect(idOf(await t.tools().start({ task: 'second' }))).toBeTruthy();
  });
});

const session = (t: { session: unknown }): never => t.session as never;

/** The real host and the real wiring, down to the handler the Mac and the phone call. */
function real() {
  const store = freshStore();
  const toasts: string[] = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-threads-stop-'));
  const chats = new Map<string, Workspace>();
  const add = (id: string, fields: Partial<Workspace> = {}): Workspace => {
    const ws: Workspace = { id, projectRoot: dir, name: id, path: dir, kind: 'worktree', createdAt: 1, projectId: 'p1', external: false, ...fields };
    chats.set(id, ws);
    return ws;
  };
  add('root');
  const running = new Set<string>();
  /** Every prompt a run got: a wake starts with [beluga]. */
  const prompts: string[] = [];
  const turns = new Map<string, { readonly finish: (text: string) => void; readonly fail: (why: string) => void }>();
  const agent: AgentBackend = {
    run(input: AgentRunInput) {
      const channel = input.channel ?? 'room';
      if (input.signal.aborted) return Promise.reject(new Error('aborted'));
      prompts.push(input.prompt);
      running.add(channel);
      return new Promise<string>((resolve, reject) => {
        const end = (): void => void running.delete(channel);
        turns.set(channel, { finish: (text) => (end(), resolve(text)), fail: (why) => (end(), reject(new Error(why))) });
        input.signal.addEventListener('abort', () => {
          end();
          reject(new Error('aborted'));
        });
      });
    },
  };
  const host: AgentHost = new AgentHost({
    store,
    selfId: () => ME,
    send: (body) => {
      if (body.kind === 'agent_event') store.dispatch({ type: 'agent_event', owner: ME, requestId: body.requestId, requester: ME, event: body.event, text: body.text ?? '', ts: Date.now(), channel: body.channel ?? 'room' });
      return true;
    },
    agent: () => agent,
    shares: { roots: () => [] } as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: (text) => void toasts.push(text),
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place: () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, inChannel: () => undefined, manager: { list: [] } } as never,
    isGuest: () => false,
  });
  const ask = (requestId: string, channel: string, prompt: string, urgent = false) => host.onAgentRequest(ME, { kind: 'agent_request', requestId, prompt, viaAgent: false, channel, urgent, plan: false });
  const manager = {
    get list() {
      return [{ id: 'p1', name: 'app', root: dir, base: 'main', workspaces: [...chats.values()] }];
    },
    find: (id: string) => chats.get(id),
    setThread: (id: string, thread: Workspace['thread']) => void chats.set(id, { ...chats.get(id)!, thread }),
    setAgent: () => undefined,
    setEffort: () => undefined,
  };
  let n = 0;
  const session = {
    store,
    selfId: ME,
    host,
    workspaces: {
      manager,
      setThread: manager.setThread,
      refresh: async () => undefined,
      isLeaving: () => false,
      ensureLoaded: () => undefined,
      newWorktree: async (_p: string, name: string, o: { thread: Workspace['thread'] }) => add(`t${++n}`, { name, thread: o.thread }),
      newChat: async () => undefined,
    },
    sendChat: () => undefined,
    // As the real one: delivered on the next turn (Session.loopback).
    requestAgent: (_to: string, prompt: string, _via: boolean, channel: string, urgent: boolean, _project: string | undefined, requestId: string) => void setImmediate(() => void ask(requestId, channel, prompt, urgent)),
    runsAgent: () => true,
    canSteer: () => true,
    toast: (text: string) => void toasts.push(text),
  };
  const off = launchThreads(session as never, { wakeMs: WAKE_MS });
  const threads = threadsOf(session)!;
  const stop = (channel: string): { stopped?: boolean; returned?: string[] } => HANDLERS['host.stopRun'](session as never, channel as never) as never;
  /** A parent working on one turn, with 3 children working under it. */
  const family = async () => {
    await ask('parent', 'ws:root', '[parent]');
    await waitFor(() => running.has('ws:root'));
    const tools = threads.forRun('ws:root')!;
    const kids: string[] = [];
    for (const task of ['a', 'b', 'c']) kids.push(`ws:${idOf(await tools.start({ task, title: task }))}`);
    await waitFor(() => kids.every((k) => running.has(k)));
    return kids;
  };
  const wakes = (): string[] => prompts.filter((p) => p.startsWith('[beluga]'));
  return { session, store, host, toasts, running, turns, wakes, chats, ask, stop, family, tools: (channel: string) => threads.forRun(channel)!, off };
}

describe('the real Stop', () => {
  it('threads.stop, the phone\'s and the Threads panel\'s: that child and those under it stop, its siblings go on', async () => {
    const t = real();
    const [kid, sibling] = await t.family();
    const grandchild = `ws:${idOf(await t.tools(kid!).start({ task: 'deep', title: 'deep' }))}`;
    await waitFor(() => t.running.has(grandchild));
    expect(phoneMay('threads.stop')).toBe(true);
    HANDLERS['threads.stop'](session(t), kid!.slice(3));
    await waitFor(() => !t.running.has(kid!) && !t.running.has(grandchild));
    expect(t.running.has(sibling!)).toBe(true);
    expect(t.running.has('ws:root')).toBe(true);
    t.stop('ws:root');
    await waitFor(() => t.running.size === 0);
    t.off();
  });

  it('stops the parent and its 3 children, the toast says how many, and no wake follows', async () => {
    const t = real();
    const kids = await t.family();
    t.toasts.length = 0;
    expect(t.stop('ws:root')).toMatchObject({ stopped: true });
    await waitFor(() => t.running.size === 0);
    expect(t.toasts).toEqual(['Stopped your agent here and 3 threads']);
    for (const k of kids) await waitFor(() => t.chats.get(k.slice(3))!.thread!.outcome?.state === 'stopped');
    await settle();
    expect(t.running.size).toBe(0);
    expect(t.wakes()).toEqual([]);
    t.off();
  });

  it('Stop All Running on a chat: its threads stop, the toast counts them, no wake follows, and its own turn goes on', async () => {
    const t = real();
    const kids = await t.family();
    const grandchild = `ws:${idOf(await t.tools(kids[0]!).start({ task: 'deep', title: 'deep' }))}`;
    await waitFor(() => t.running.has(grandchild));
    t.toasts.length = 0;
    expect(HANDLERS['threads.stopAll'](session(t), 'root')).toEqual({ stopped: 4 });
    await waitFor(() => [...kids, grandchild].every((k) => !t.running.has(k)));
    expect(t.toasts).toEqual(['Stopped 4 threads']);
    for (const k of [...kids, grandchild]) await waitFor(() => t.chats.get(k.slice(3))!.thread!.outcome?.delivered === true);
    expect(t.running.has('ws:root')).toBe(true);
    t.stop('ws:root');
    await waitFor(() => !t.running.has('ws:root'));
    await settle();
    expect(t.wakes()).toEqual([]);
    t.off();
  });

  it('Stop All Running with an idle parent: a result still on its way does not wake it', async () => {
    const t = real();
    const [finished, ...working] = await t.family();
    t.host.stopRun('ws:root');
    await t.host.idle('ws:root');
    t.turns.get(finished!)!.finish('All green.');
    await waitFor(() => t.chats.get(finished!.slice(3))!.thread!.outcome?.state === 'done');
    expect(HANDLERS['threads.stopAll'](session(t), 'root')).toEqual({ stopped: 2 });
    await waitFor(() => working.every((k) => !t.running.has(k)));
    await settle();
    expect(t.wakes()).toEqual([]);
    expect(t.chats.get(finished!.slice(3))!.thread!.outcome?.delivered).toBe(true);
    t.off();
  });

  it('with nothing working, Stop All Running says so', async () => {
    const t = real();
    expect(HANDLERS['threads.stopAll'](session(t), 'root')).toEqual({ stopped: 0 });
    expect(t.toasts).toEqual(['No thread is running here']);
    t.off();
  });

  it('a Stop on a thread that was just started: its request is in a lane already, so it never starts afterwards', async () => {
    const t = real();
    await t.ask('parent', 'ws:root', '[parent]');
    await waitFor(() => t.running.has('ws:root'));
    const id = idOf(await t.tools('ws:root').start({ task: 'late', title: 'late' }));
    // Promises settle, and no timer or socket message runs: a Stop lands no earlier than this.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    HANDLERS['threads.stop'](session(t), id);
    await settle();
    expect(t.running.has(`ws:${id}`)).toBe(false);
    expect(t.chats.get(id)!.thread!.outcome?.state).toBe('stopped');
    expect(t.toasts.some((m) => /isn.t working here|not running anything/.test(m))).toBe(false);
    t.off();
  });

  it('a parent that fails with results held gets them once, in the next wake', async () => {
    const t = real();
    const [kid] = await t.family();
    t.turns.get(kid!)!.finish('All green.');
    await waitFor(() => t.chats.get(kid!.slice(3))!.thread!.outcome?.state === 'done');
    await settle();
    expect(t.wakes()).toEqual([]);
    t.turns.get('ws:root')!.fail('boom');
    await waitFor(() => t.wakes().length === 1);
    expect(t.wakes()[0]).toContain('All green.');
    await settle();
    expect(t.wakes()).toHaveLength(1);
    t.stop('ws:root');
    t.off();
  });

  it('with no children the toast is what it was', async () => {
    const t = real();
    await t.ask('parent', 'ws:root', '[parent]');
    await waitFor(() => t.running.has('ws:root'));
    t.stop('ws:root');
    expect(t.toasts).toEqual(['Stopped your agent here']);
    t.off();
  });

  it('a parent with no running turn: the children stop, and the toast says only that', async () => {
    const t = real();
    const kids = await t.family();
    t.host.stopRun('ws:root');
    await t.host.idle('ws:root');
    t.toasts.length = 0;
    expect(t.stop('ws:root')).toMatchObject({ stopped: true, returned: [] });
    await waitFor(() => kids.every((k) => !t.running.has(k)));
    expect(t.toasts).toEqual(['Stopped 3 threads']);
    t.off();
  });

  it('a queued prompt of yours comes back to the box', async () => {
    const t = real();
    await t.family();
    await t.ask('later', 'ws:root', 'my next message');
    const out = t.stop('ws:root');
    expect(out.returned).toEqual(['my next message']);
    expect(t.toasts.at(-1)).toBe('Stopped your agent here and 3 threads · 1 queued message back in the box');
    t.off();
  });
});

describe('stops that are not a person’s Stop on the parent leave the children running', () => {
  const stillRunning = async (t: ReturnType<typeof real>, kids: string[]): Promise<void> => {
    await settle();
    expect(kids.every((k) => t.running.has(k))).toBe(true);
    for (const k of kids) expect(t.chats.get(k.slice(3))!.thread!.stopped).toBeUndefined();
  };

  it('the archive path (host.stopRun)', async () => {
    const t = real();
    const kids = await t.family();
    t.host.stopRun('ws:root');
    await stillRunning(t, kids);
    t.off();
  });

  it('a steer', async () => {
    const t = real();
    const kids = await t.family();
    await t.ask('steer', 'ws:root', '[parent] now', true);
    await stillRunning(t, kids);
    t.off();
  });

  it('the watchdog', async () => {
    const t = real();
    const kids = await t.family();
    await t.host.takeOver('ws:root');
    await stillRunning(t, kids);
    t.off();
  });

  it('a run ended by Beluga (endIn)', async () => {
    const t = real();
    const kids = await t.family();
    await t.host.endIn('ws:root', 'Archived');
    await stillRunning(t, kids);
    t.off();
  });
});
