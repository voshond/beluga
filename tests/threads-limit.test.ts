import { describe, expect, it } from 'vitest';
import { ThreadService, type ThreadServiceDeps } from '../src/core/threads/service.js';
import { Store, initialState } from '../src/core/store.js';
import { encodeFailure } from '../src/shared/run-failure.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

/** A thread that hits your usage limit (BLG-344): it waits for the auto-continue like any chat, and the parent gets one result. */

const ME = 'me';
const WAKE_MS = 15;
const settle = (ms = WAKE_MS * 4): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: ME, isHost: true, home: '/home/me' });
  store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
  const chats = new Map<string, Workspace>();
  const wakes: Array<{ channel: string; prompt: string; requestId: string }> = [];
  const asks: Array<{ channel: string; id: string }> = [];
  let n = 0;
  const add = (id: string, fields: Partial<Workspace> = {}): Workspace => {
    const ws: Workspace = { id, projectRoot: '/code/app', name: id, path: `/code/app/${id}`, kind: 'worktree', createdAt: 1, projectId: 'p1', external: false, ...fields };
    chats.set(id, ws);
    return ws;
  };
  add('root');
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
    wake: (channel, prompt, _line, requestId) => void wakes.push({ channel, prompt, requestId }),
    wakeMs: WAKE_MS,
    hasMacChat: () => true,
    terminalDriving: () => false,
  };
  const service = new ThreadService(deps);
  const start = async (task: string): Promise<{ id: string; channel: string; request: string }> => {
    const answer = await service.forRun('ws:root')!.start({ task, title: task });
    const id = /thread "([^"]+)"/.exec(answer)![1]!;
    return { id, channel: `ws:${id}`, request: asks.at(-1)!.id };
  };
  const end = (channel: string, requestId: string, event: 'done' | 'error', text: string) => store.dispatch({ type: 'agent_event', owner: ME, requestId, requester: ME, event, text, ts: Date.now(), channel });
  const limit = (channel: string, requestId: string, resetsAt?: number) => end(channel, requestId, 'error', encodeFailure({ kind: 'usage_limit', detail: 'limit', ...(resetsAt ? { resetsAt } : {}) }));
  const status = async (id: string) => JSON.parse(await service.forRun('ws:root')!.status({ id })) as Record<string, unknown>;
  const startUnder = async (parent: string, task: string): Promise<{ id: string; channel: string; request: string }> => {
    const answer = await service.forRun(parent)!.start({ task, title: task });
    const id = /thread "([^"]+)"/.exec(answer)![1]!;
    return { id, channel: `ws:${id}`, request: asks.at(-1)!.id };
  };
  return { store, service, chats, wakes, start, startUnder, end, limit, status };
}

describe('a thread that hits the usage limit', () => {
  it('with a known reset waits for the limit, wakes no parent with a failure, and wakes it once after the continued turn', async () => {
    const t = setup();
    const k = await t.start('a');
    const resetsAt = Date.now() + 3_600_000;
    t.limit(k.channel, k.request, resetsAt);
    await settle();
    expect(t.wakes).toEqual([]);
    expect(await t.status(k.id)).toMatchObject({ state: 'waiting_limit', resumesAt: resetsAt + 60_000 });
    // Beluga's auto-continue sends its prompt in the child: that turn is owed to the parent.
    t.service.limitContinued(k.channel, 'cont-1');
    expect(await t.status(k.id)).toMatchObject({ state: 'queued' });
    t.end(k.channel, 'cont-1', 'done', 'Finished after the reset');
    await waitFor(() => t.wakes.length === 1);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt).toContain('Finished after the reset');
    expect(t.wakes[0]!.prompt).not.toMatch(/usage limit/);
  });

  it('with auto-continue off, the parent gets the limit as the result once, with the reset time', async () => {
    const t = setup();
    t.store.dispatch({ type: 'prefs', prefs: { autoContinue: false } });
    const k = await t.start('a');
    t.limit(k.channel, k.request, Date.now() + 3_600_000);
    await waitFor(() => t.wakes.length === 1);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt).toMatch(/usage limit · resets at/);
    expect(await t.status(k.id)).toMatchObject({ state: 'failed' });
  });

  it('off for that chat, or with no known reset, the parent gets the limit as the result once', async () => {
    const t = setup();
    const a = await t.start('a');
    t.store.dispatch({ type: 'prefs', prefs: { autoContinueOff: [a.channel] } });
    t.limit(a.channel, a.request, Date.now() + 3_600_000);
    const b = await t.start('b');
    t.limit(b.channel, b.request);
    await waitFor(() => t.wakes.length === 1);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt.match(/usage limit/g)).toHaveLength(2);
  });

  it('turning auto-continue off while it waits reports the limit to the parent once', async () => {
    const t = setup();
    const k = await t.start('a');
    t.limit(k.channel, k.request, Date.now() + 3_600_000);
    await settle();
    expect(t.wakes).toEqual([]);
    t.store.dispatch({ type: 'prefs', prefs: { autoContinueOff: [k.channel] } });
    await waitFor(() => t.wakes.length === 1);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]!.prompt).toMatch(/usage limit/);
  });

  it('a person’s Stop on a waiting thread stops it, and the auto-continue skips it', async () => {
    const t = setup();
    const k = await t.start('a');
    t.limit(k.channel, k.request, Date.now() + 3_600_000);
    await settle();
    expect(t.service.stopTree('ws:root')).toBe(1);
    expect(await t.status(k.id)).toMatchObject({ state: 'stopped' });
    expect(t.service.skipsContinue(k.channel)).toBe(true);
    await settle();
    expect(t.wakes).toEqual([]);
  });

  it('holds a child’s result while its parent waits on the limit, and brings it once after the parent goes on', async () => {
    const t = setup();
    const p = await t.start('lead');
    const g = await t.startUnder(p.channel, 'grand');
    t.limit(p.channel, p.request, Date.now() + 3_600_000);
    t.end(g.channel, g.request, 'done', 'Grandchild result');
    await settle();
    expect(t.wakes).toEqual([]);
    expect(t.chats.get(g.id)!.thread!.outcome?.delivered).toBe(false);
    t.service.limitContinued(p.channel, 'cont-p');
    t.store.dispatch({ type: 'agent_event', owner: 'me', requestId: 'cont-p', requester: 'me', event: 'started', text: '', ts: Date.now(), channel: p.channel });
    t.end(p.channel, 'cont-p', 'done', 'Lead result');
    // The parent goes on: the held result wakes it once, and that turn's answer goes up to the root.
    await waitFor(() => t.wakes.length === 1);
    await settle();
    expect(t.wakes).toHaveLength(1);
    expect(t.wakes[0]).toMatchObject({ channel: p.channel });
    expect(t.wakes[0]!.prompt).toContain('Grandchild result');
    t.store.dispatch({ type: 'agent_event', owner: 'me', requestId: t.wakes[0]!.requestId, requester: 'me', event: 'started', text: '', ts: Date.now(), channel: p.channel });
    t.end(p.channel, t.wakes[0]!.requestId, 'done', 'Lead read the grandchild');
    await waitFor(() => t.wakes.length === 2);
    await settle();
    expect(t.wakes).toHaveLength(2);
    expect(t.wakes[1]).toMatchObject({ channel: 'ws:root' });
    expect(t.wakes[1]!.prompt).toContain('Lead read the grandchild');
  });
});
