import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { batchCalls, threadFamily } from '../packages/mac/src/lib/thread-family.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { ThreadService } from '../src/core/threads/service.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import type { ThreadRecord } from '../src/shared/threads.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import type { Workspace } from '../src/workspaces/types.js';

const sh = (cwd: string, ...args: string[]): void => void execFileSync('git', args, { cwd, stdio: 'pipe' });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

let store: Store;
let manager: WorkspaceManager;
let ctl: WorkspaceController;
let toasts: string[];
let projectId: string;

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-threads-remove-')));
  const repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  store = new Store(initialState('room'));
  store.dispatch({ type: 'prefs', prefs: { agentThreads: true } });
  toasts = [];
  manager = new WorkspaceManager(wsStore);
  ctl = new WorkspaceController({ manager, store, shares: new ShareService([]), selfId: () => 'me', toast: (t) => void toasts.push(t), intend: () => undefined, askClaude: () => undefined, claudeHome: path.join(base, 'claude'), moveToTrash: async () => undefined });
  await ctl.refresh();
  projectId = manager.list.find((p) => p.root)!.id;
});

const record = (parent: string, parentTitle: string, root: string, depth: number): ThreadRecord => ({ parent, parentTitle, root, depth, task: 'work', startedAt: 1, owed: [] });

async function chat(title: string, thread?: ThreadRecord): Promise<Workspace> {
  const ws = await ctl.newChat(projectId, title, undefined, { quiet: true, ...(thread ? { thread } : {}) });
  return ws!;
}

/** A parent, its two threads, and a thread under the first. */
async function family() {
  const parent = await chat('Parent');
  const root = `ws:${parent.id}`;
  const child = await chat('Child', record(root, 'Parent', root, 1));
  const other = await chat('Other', record(root, 'Parent', root, 1));
  const grand = await chat('Grand', record(`ws:${child.id}`, 'Child', root, 2));
  return { parent, root, child, other, grand };
}

const now = (id: string): Workspace | undefined => manager.find(id);

describe('keep (every call’s default)', () => {
  it('archive: each direct thread stands on its own; a grandchild keeps its parent and root', async () => {
    const f = await family();
    expect(await ctl.archive(f.parent.id)).toBe(true);
    for (const c of [f.child, f.other]) {
      expect(now(c.id)!.archived).toBeFalsy();
      expect(now(c.id)!.thread).toMatchObject({ parentGone: true, parentTitle: 'Parent', root: f.root, parent: f.root });
    }
    expect(now(f.grand.id)!.archived).toBeFalsy();
    expect(now(f.grand.id)!.thread).toMatchObject({ parent: `ws:${f.child.id}`, root: f.root, depth: 2 });
    expect(now(f.grand.id)!.thread!.parentGone).toBeUndefined();
  });

  it('delete: the same, and the parent is gone', async () => {
    const f = await family();
    await ctl.remove(f.parent.id, { children: 'keep' });
    expect(now(f.parent.id)).toBeUndefined();
    expect(now(f.child.id)!.thread).toMatchObject({ parentGone: true, parentTitle: 'Parent', root: f.root });
    expect(now(f.grand.id)!.thread!.parentGone).toBeUndefined();
  });

  it('the parent’s last name is the one a kept thread keeps', async () => {
    const f = await family();
    manager.setThread(f.child.id, { ...now(f.child.id)!.thread!, parentTitle: 'Old name' });
    await ctl.remove(f.parent.id);
    expect(now(f.child.id)!.thread!.parentTitle).toBe('Parent');
  });

  it('a default call changes nothing for records with no thread', async () => {
    const parent = await chat('Plain');
    const bystander = await chat('Bystander');
    const before = now(bystander.id);
    expect(await ctl.archive(parent.id)).toBe(true);
    await ctl.remove(parent.id);
    expect(now(bystander.id)).toEqual(before);
    expect(toasts.at(-1)).toBe('Deleted.');
  });

  it('a quiet call (a plan, a sentinel) keeps the threads too', async () => {
    const f = await family();
    expect(await ctl.archive(f.parent.id, false, { quiet: true })).toBe(true);
    expect(now(f.child.id)!.archived).toBeFalsy();
    await ctl.remove(f.parent.id, { quiet: true });
    expect(now(f.child.id)).toBeDefined();
  });
});

describe('with', () => {
  it('archive: every thread goes first, depth first, and each link stays', async () => {
    const f = await family();
    const order: string[] = [];
    const real = manager.archive.bind(manager);
    vi.spyOn(manager, 'archive').mockImplementation((id, phase) => (order.push(id), real(id, phase)));
    expect(await ctl.archive(f.parent.id, false, { children: 'with' })).toBe(true);
    expect(order).toHaveLength(4);
    expect(order.indexOf(f.grand.id)).toBeLessThan(order.indexOf(f.child.id));
    expect(order.at(-1)).toBe(f.parent.id);
    for (const c of [f.child, f.other, f.grand]) {
      expect(now(c.id)!.archived).toBe(true);
      expect(now(c.id)!.thread!.parentGone).toBeUndefined();
    }
    expect(toasts.at(-1)).toContain('Also archived 3 threads.');
  });

  it('delete: every thread goes, depth first', async () => {
    const f = await family();
    const order: string[] = [];
    const real = manager.remove.bind(manager);
    vi.spyOn(manager, 'remove').mockImplementation((id) => (order.push(id), real(id)));
    await ctl.remove(f.parent.id, { children: 'with' });
    expect(order).toHaveLength(4);
    expect(order.indexOf(f.grand.id)).toBeLessThan(order.indexOf(f.child.id));
    expect(order.at(-1)).toBe(f.parent.id);
    for (const c of [f.parent, f.child, f.other, f.grand]) expect(now(c.id)).toBeUndefined();
    expect(toasts.at(-1)).toContain('Also deleted 3 threads.');
  });

  it('a thread that was archived already stays as it is, and a delete takes it too', async () => {
    const f = await family();
    await ctl.archive(f.other.id);
    toasts.length = 0;
    expect(await ctl.archive(f.parent.id, false, { children: 'with' })).toBe(true);
    expect(toasts.filter((t) => /Couldn/.test(t))).toEqual([]);
    expect(toasts.at(-1)).toContain('Also archived 2 threads.');
    await ctl.remove(f.parent.id, { children: 'with' });
    expect(now(f.other.id)).toBeUndefined();
  });

  it('a thread that cannot go stays, on its own, and the rest go on', async () => {
    const f = await family();
    const real = manager.archive.bind(manager);
    vi.spyOn(manager, 'archive').mockImplementation((id, phase) => (id === f.other.id ? Promise.reject(new Error('locked')) : real(id, phase)));
    expect(await ctl.archive(f.parent.id, false, { children: 'with' })).toBe(true);
    expect(now(f.child.id)!.archived).toBe(true);
    expect(now(f.other.id)!.archived).toBeFalsy();
    expect(now(f.other.id)!.thread!.parentGone).toBe(true);
  });

  it('when the parent itself fails, what is still here keeps its link', async () => {
    const f = await family();
    vi.spyOn(manager, 'remove').mockRejectedValueOnce(new Error('locked'));
    await ctl.remove(f.parent.id);
    expect(now(f.parent.id)).toBeDefined();
    expect(now(f.child.id)!.thread!.parentGone).toBeUndefined();
  });
});

describe('restoring an archived parent', () => {
  it('its archived threads link to it again', async () => {
    const f = await family();
    await ctl.archive(f.parent.id, false, { children: 'with' });
    await ctl.restore(f.parent.id);
    expect(now(f.parent.id)!.archived).toBeFalsy();
    expect(now(f.child.id)!.archived).toBe(true);
    expect(now(f.child.id)!.thread).toMatchObject({ parent: f.root });
    expect(now(f.child.id)!.thread!.parentGone).toBeUndefined();
  });

  it('a thread kept beside it links to it again too', async () => {
    const f = await family();
    await ctl.archive(f.parent.id);
    expect(now(f.child.id)!.thread!.parentGone).toBe(true);
    await ctl.restore(f.parent.id);
    expect(now(f.child.id)!.thread!.parentGone).toBeUndefined();
  });
});

describe('a kept thread, on the real records', () => {
  function service(wakes: string[], asks: Array<{ channel: string; id: string }>, stops: string[]): ThreadService {
    return new ThreadService({
      store,
      selfId: () => 'me',
      projects: () => manager.list,
      find: (id) => manager.find(id),
      setThread: (id, thread) => manager.setThread(id, thread),
      newWorktree: async () => undefined,
      newChat: (p, title, o) => ctl.newChat(p, title, undefined, { quiet: true, ...o }),
      setAgent: () => undefined,
      setEffort: () => undefined,
      ask: (_prompt, channel, id) => void asks.push({ channel, id }),
      stopRun: (channel) => void stops.push(channel),
      runsAgent: () => true,
      canSteer: () => true,
      wake: (channel) => void wakes.push(channel),
      wakeMs: 5,
      hasMacChat: () => true,
      leaving: (id) => ctl.isLeaving(id),
      terminalDriving: () => false,
    });
  }
  const finish = (channel: string, requestId: string, event: 'done' | 'error' = 'done', text = 'Done.') => store.dispatch({ type: 'agent_event', owner: 'me', requestId, requester: 'me', event, text, ts: Date.now(), channel });

  it('still runs, keeps its result, can start a thread and can be stopped; nothing wakes the gone parent', async () => {
    const wakes: string[] = [];
    const asks: Array<{ channel: string; id: string }> = [];
    const stops: string[] = [];
    const threads = service(wakes, asks, stops);
    const parent = await chat('Parent');
    const started = await threads.forRun(`ws:${parent.id}`)!.start({ task: 'work', title: 'Kept', where: 'read' });
    const kept = /thread "([^"]+)"/.exec(started)![1]!;
    await ctl.remove(parent.id);
    expect(now(kept)!.thread!.parentGone).toBe(true);

    finish(`ws:${kept}`, asks[0]!.id);
    await settle();
    expect(wakes).toEqual([]);
    expect(now(kept)!.thread!.outcome).toMatchObject({ state: 'done', delivered: false });

    const under = await threads.forRun(`ws:${kept}`)!.start({ task: 'more', title: 'Under', where: 'read' });
    const grand = /thread "([^"]+)"/.exec(under)![1]!;
    expect(now(grand)!.thread).toMatchObject({ parent: `ws:${kept}` });
    expect(threads.stopTree(`ws:${kept}`)).toBe(1);
    expect(stops).toEqual([`ws:${grand}`]);
    threads.stop();
  });

  it('with: a thread’s last turn does not wake the parent that is going, and a restore brings it', async () => {
    const wakes: string[] = [];
    const asks: Array<{ channel: string; id: string }> = [];
    const threads = service(wakes, asks, []);
    const parent = await chat('Parent');
    const started = await threads.forRun(`ws:${parent.id}`)!.start({ task: 'work', title: 'Child', where: 'read' });
    const id = /thread "([^"]+)"/.exec(started)![1]!;
    const real = manager.archive.bind(manager);
    vi.spyOn(manager, 'archive').mockImplementation(async (a, phase) => {
      // The child's turn ends while the family is going.
      if (a === id) finish(`ws:${id}`, asks[0]!.id, 'error', 'Stopped: its worktree was archived');
      await settle();
      return real(a, phase);
    });
    await ctl.archive(parent.id, false, { children: 'with' });
    await settle();
    expect(wakes).toEqual([]);
    expect(now(id)!.thread!.outcome?.delivered).toBe(false);
    await ctl.restore(parent.id);
    await settle();
    expect(wakes).toEqual([`ws:${parent.id}`]);
    threads.stop();
  });
});

describe('a batch in the Worktrees view', () => {
  const picked = (ids: readonly string[], children?: 'with' | 'keep') => batchCalls({ projects: manager.list as never }, ids, children);
  const noneFailed = (): void => expect(toasts.filter((t) => /Couldn/.test(t))).toEqual([]);

  it('with: a parent and its child make one call for the child, and no call fails', async () => {
    const f = await family();
    const calls = picked([f.child.id, f.parent.id], 'with');
    expect(calls).toEqual([f.parent.id]);
    const spy = vi.spyOn(manager, 'archive');
    expect(await Promise.all(calls.map((id) => ctl.archive(id, false, { children: 'with' })))).toEqual([true]);
    expect(spy.mock.calls.filter(([id]) => id === f.child.id)).toHaveLength(1);
    noneFailed();
    expect(now(f.child.id)!.archived).toBe(true);
    expect(now(f.grand.id)!.archived).toBe(true);
  });

  it('with, delete: the same, in parallel with a row of its own', async () => {
    const f = await family();
    const alone = await chat('Alone');
    const calls = picked([f.grand.id, f.parent.id, alone.id], 'with');
    expect(calls).toEqual([f.parent.id, alone.id]);
    const spy = vi.spyOn(manager, 'remove');
    await Promise.all(calls.map((id) => ctl.remove(id, { children: 'with' })));
    expect(spy.mock.calls.filter(([id]) => id === f.grand.id)).toHaveLength(1);
    noneFailed();
    for (const c of [f.parent, f.child, f.other, f.grand, alone]) expect(now(c.id)).toBeUndefined();
  });

  it('a row under a picked row’s picked row is covered, also with the middle one not picked', async () => {
    const f = await family();
    expect(picked([f.parent.id, f.grand.id], 'with')).toEqual([f.parent.id]);
    expect(picked([f.child.id, f.grand.id, f.other.id], 'with')).toEqual([f.child.id, f.other.id]);
  });

  it('keep: a picked child stays picked, the parent keeps the rest, and no call fails', async () => {
    const f = await family();
    const calls = picked([f.parent.id, f.child.id], 'keep');
    expect(calls).toEqual([f.parent.id, f.child.id]);
    await Promise.all(calls.map((id) => ctl.remove(id, { children: 'keep' })));
    noneFailed();
    expect(now(f.parent.id)).toBeUndefined();
    expect(now(f.child.id)).toBeUndefined();
    expect(now(f.other.id)!.thread!.parentGone).toBe(true);
    expect(now(f.grand.id)!.thread!.parentGone).toBe(true);
  });

  it('with no question asked, each row is its own call', async () => {
    const f = await family();
    expect(picked([f.parent.id, f.child.id])).toEqual([f.parent.id, f.child.id]);
  });
});

describe('what the dialog counts', () => {
  const ws = (id: string, thread?: ThreadRecord, archived?: boolean): Workspace => ({ id, projectRoot: '/r', name: id, path: `/r/${id}`, kind: 'chat', createdAt: 1, projectId: 'p', external: false, ...(thread ? { thread } : {}), ...(archived ? { archived: true } : {}) }) as Workspace;
  const state = (log: object[] = []) => ({
    selfId: 'me',
    log: log as never,
    projects: [{ id: 'p', name: 'p', root: '/r', workspaces: [ws('a'), ws('b', record('ws:a', 'a', 'ws:a', 1)), ws('c', record('ws:b', 'b', 'ws:a', 2)), ws('d', record('ws:a', 'a', 'ws:a', 1), true), ws('z')] }] as never,
  });

  it('the whole tree, with those working now; an archive leaves out the archived', () => {
    expect(threadFamily(state(), 'a', 'delete')).toEqual({ count: 3, running: 0 });
    expect(threadFamily(state(), 'a', 'archive')).toEqual({ count: 2, running: 0 });
    expect(threadFamily(state([{ type: 'agent', owner: 'me', status: 'started', channel: 'ws:c' }]), 'a', 'archive')).toEqual({ count: 2, running: 1 });
  });

  it('picked rows: every tree, each thread once, and a picked thread is not asked about', () => {
    expect(threadFamily(state(), ['a', 'b'], 'delete')).toEqual({ count: 2, running: 0 });
    expect(threadFamily(state(), ['b', 'a', 'c', 'd'], 'delete')).toEqual({ count: 0, running: 0 });
    expect(threadFamily(state(), ['b', 'z'], 'archive')).toEqual({ count: 1, running: 0 });
  });

  it('a chat with no threads has nothing to ask', () => {
    expect(threadFamily(state(), 'z', 'archive')).toEqual({ count: 0, running: 0 });
  });
});
