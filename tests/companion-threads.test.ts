import { describe, expect, it, vi } from 'vitest';
import { calls } from '../packages/companion/lib/link/calls.js';
import { branchChildren, familyRows, familyRunning, nestRows, threadsQuestion } from '../packages/companion/lib/thread-rows.js';
import { branchStep } from '../src/companion/branch-steps.js';
import { phoneMay } from '../src/companion/coverage.js';
import { COMPANION_PROTO, ConvView, type ConvSummary, HomeView, SINCE, type Topic, WorkView } from '../src/companion/protocol.js';
import { type ViewContext, needsYou, viewOf } from '../src/companion/views.js';
import { type DomainState, initialState } from '../src/core/store.js';
import { parseArgs } from '../src/ipc/api.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import type { ThreadRecord } from '../src/shared/threads.js';
import type { Workspace } from '../src/workspaces/types.js';

const ME = 'me0000000000000000000000000000me';
const ctx: ViewContext = { refs: { output: () => undefined }, mac: { name: 'Mac', version: '2' } };

const thread = (parent: string, startedAt = 1, extra: Partial<ThreadRecord> = {}): ThreadRecord => ({ parent, parentTitle: 'Old title', root: parent, depth: 1, task: 'SECRET TASK `rm -rf`', startedAt, owed: [], ...extra });
const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name: `${id} chat`, kind: 'chat', projectId: 'p', external: false, path: `/${id}`, projectRoot: '/p', createdAt: 1, ...extra }) as Workspace;

function state(workspaces: Workspace[], on = true, extra: Partial<DomainState> = {}): DomainState {
  return { ...initialState('room', 'ask', { agentThreads: on }), selfId: ME, projects: [{ id: 'p', name: 'p', root: '/p', workspaces }], ...extra } as DomainState;
}
const running = (channel: string) => ({ type: 'agent', channel, owner: ME, status: 'started', requestId: `r-${channel}`, ts: 5, steps: [], subagents: [], prompt: 'p', text: '' });
const work = (st: DomainState) => WorkView.parse(viewOf(st, ctx, 'work')).projects[0]!.conversations;
const row = (st: DomainState, id: string) => work(st).find((c) => c.topic === `conv:ws:${id}`)!;
const conv = (st: DomainState, id: string) => ConvView.parse(viewOf(st, ctx, `conv:ws:${id}` as Topic));

const codex = { runtime: 'codex', label: 'Codex' } as Workspace['agent'];
const family = () => [ws('top', { agent: codex }), ws('kid', { thread: thread('ws:top', 2) }), ws('grand', { thread: thread('ws:kid', 3) })];

describe('the protocol', () => {
  it('raises the minor and gates threads in SINCE', () => {
    expect(COMPANION_PROTO.minor).toBeGreaterThanOrEqual(SINCE.threads);
    expect(SINCE.threads).toBe(50);
    expect(SINCE.threadAgents).toBe(50);
  });

  it('a family from an older Mac, with no sub-agents, still reads', () => {
    expect(ConvView.shape.threadFamily.unwrap().safeParse({ children: [], chat: 'top', stoppable: [] }).success).toBe(true);
  });
});

describe('the phone’s Threads sheet', () => {
  const child = (id: string, state: 'running' | 'done' | 'needs_you') => ({ id, topic: `conv:ws:${id}` as Topic, title: id, state, working: state !== 'done', harness: { runtime: 'claude' as const, label: 'Claude' } });
  const agent = (id: string, state: 'running' | 'done', startedAt: number) => ({ id, title: id, state, startedAt, harness: { runtime: 'claude' as const, label: 'Claude' } });

  it('lists threads and native sub-agents in one list, most urgent first, with one running count', () => {
    const tf = { children: [child('ask', 'needs_you'), child('work', 'running'), child('old', 'done')], agents: [agent('a2', 'done', 2), agent('a1', 'running', 1)], chat: 'top', stoppable: ['ask', 'work'] };
    expect(familyRows(tf).map((r) => [r.kind, r.id])).toEqual([['thread', 'ask'], ['thread', 'work'], ['agent', 'a1'], ['thread', 'old'], ['agent', 'a2']]);
    expect(familyRunning(tf)).toBe(3);
    expect(familyRows({ ...tf, agents: undefined }).map((r) => r.id)).toEqual(['ask', 'work', 'old']);
  });
});

describe('Work', () => {
  it('gives each chat its harness and a child its parent', () => {
    const st = state(family());
    expect(row(st, 'top')).toMatchObject({ harness: { runtime: 'codex', label: 'Codex' } });
    expect(row(st, 'top').parent).toBeUndefined();
    expect(row(st, 'kid').parent).toBe('conv:ws:top');
    expect(row(st, 'grand').parent).toBe('conv:ws:kid');
    expect(row(st, 'kid').harness?.runtime).toBeTruthy();
  });

  it('BLG-345: shows no harness when the listed chats use one harness, and says so to the sheet', () => {
    const one = state([ws('top'), ws('kid', { thread: thread('ws:top', 2) })]);
    expect(row(one, 'top').harness).toBeUndefined();
    expect(row(one, 'kid').harness).toBeUndefined();
    expect(conv(one, 'top').threadFamily).toMatchObject({ marks: false });
    expect(conv(state(family()), 'top').threadFamily).toMatchObject({ marks: true });
  });

  it('keeps a child with a gone parent at the top level', () => {
    const st = state([ws('kid', { thread: thread('ws:top', 1, { parentGone: true }) })]);
    expect(row(st, 'kid').parent).toBeUndefined();
    expect(row(st, 'kid').title).toBe('kid chat');
  });

  it('says nothing with threads off, and nothing about a row on Home', () => {
    const off = state(family(), false);
    expect(row(off, 'kid').parent).toBeUndefined();
    expect(row(off, 'kid').harness).toBeUndefined();
    const home = HomeView.parse(viewOf(state(family(), true, { log: [running('ws:kid')] as never }), ctx, 'home'));
    expect(home.running[0]?.parent).toBeUndefined();
  });
});

describe('a chat’s Threads', () => {
  it('for a parent: its children, the most urgent first, and every working thread to stop, deepest first', () => {
    const st = state([...family(), ws('later', { thread: thread('ws:top', 9, { outcome: { state: 'done', summary: 'Ran `rm -rf`', at: 10, delivered: true } }) })], true, { log: [running('ws:kid'), running('ws:grand')] as never });
    const { threadFamily } = conv(st, 'top');
    expect(threadFamily?.parent).toBeUndefined();
    expect(threadFamily?.children.map((c) => [c.id, c.state, c.working])).toEqual([['kid', 'running', true], ['later', 'done', false]]);
    expect(threadFamily?.children[0]).toMatchObject({ topic: 'conv:ws:kid', title: 'kid chat' });
    expect(threadFamily?.stoppable).toEqual(['grand', 'kid']);
  });

  it('for a child: the parent to open, with its live state', () => {
    const { threadFamily } = conv(state(family(), true, { log: [running('ws:top')] as never }), 'kid');
    expect(threadFamily?.parent).toEqual({ title: 'top chat', topic: 'conv:ws:top', gone: false, state: 'running' });
    expect(threadFamily?.children.map((c) => c.id)).toEqual(['grand']);
  });

  it('for a gone parent: its title in words, nothing to open', () => {
    const { threadFamily } = conv(state([ws('kid', { thread: thread('ws:top') })]), 'kid');
    expect(threadFamily?.parent).toEqual({ title: 'Old title', gone: true });
  });

  it('carries no code: a thread’s task and result stay off the phone', () => {
    const st = state([ws('top'), ws('kid', { thread: thread('ws:top', 1, { outcome: { state: 'done', summary: 'Ran `rm -rf`', at: 2, delivered: true } }) })]);
    expect(JSON.stringify(conv(st, 'top').threadFamily)).not.toMatch(/rm -rf|SECRET/);
  });

  it('lists its native sub-agents as read-only rows with the chat’s harness, and no background work', () => {
    const subagents = [
      { id: 'sa', title: 'Explore the `rm -rf` API', status: 'running', steps: ['SECRET'], startedAt: 4 },
      { id: 'old', title: 'Read the docs', status: 'done', steps: [], startedAt: 1 },
      { id: 'bg', title: 'npm test', status: 'running', steps: [], kind: 'background' },
    ];
    const st = state([...family(), ws('alone')], true, { log: [{ ...running('ws:top'), id: 'r1', subagents }, { ...running('ws:alone'), id: 'r2', subagents }] as never });
    const { threadFamily } = conv(st, 'top');
    expect(threadFamily?.agents?.map((a) => [a.id, a.state, a.harness.runtime])).toEqual([['sa', 'running', 'codex'], ['old', 'done', 'codex']]);
    expect(threadFamily?.stoppable).not.toContain('sa');
    expect(JSON.stringify(threadFamily?.agents)).not.toMatch(/SECRET/);
    // A chat with only native sub-agents has a family too.
    expect(conv(st, 'alone').threadFamily?.agents?.map((a) => a.id)).toEqual(['sa', 'old']);
    expect(conv({ ...st, prefs: { ...st.prefs, agentThreads: false } }, 'alone').threadFamily).toBeUndefined();
  });

  it('is unset with threads off, and for a chat with no family', () => {
    expect(conv(state(family(), false), 'top').threadFamily).toBeUndefined();
    expect(conv(state([ws('alone')]), 'alone').threadFamily).toBeUndefined();
  });
});

describe('what needs you in a child', () => {
  it('names the child', () => {
    const st = state(family(), true, { approvals: [{ id: 'a1', channel: 'ws:kid', title: 'Run the tests', ts: 3 }] as never });
    expect(needsYou(st)[0]).toMatchObject({ topic: 'conv:ws:kid', thread: 'kid chat' });
    const plain = state([ws('top')], true, { approvals: [{ id: 'a1', channel: 'ws:top', title: 'Run the tests', ts: 3 }] as never });
    expect(needsYou(plain)[0]?.thread).toBeUndefined();
  });
});

describe('Stop from the phone', () => {
  const session = () => {
    const stopped: string[] = [];
    return { stopped, s: { host: { stopRun: (c: string, _o?: unknown) => stopped.push(c) }, workspaces: { manager: { find: (id: string) => (id === 'kid' ? ws('kid', { thread: thread('ws:top') }) : ws(id)) } } } };
  };

  it('threads.stop is a phone call, and stops that child on the Mac', () => {
    expect(phoneMay('threads.stop')).toBe(true);
    const call = calls.stopThread('kid');
    const { s, stopped } = session();
    HANDLERS['threads.stop'](s as never, ...parseArgs('threads.stop', call.args));
    expect(stopped).toEqual(['ws:kid']);
  });
});

describe('archive and delete from the phone', () => {
  const topic = 'conv:ws:top';
  const session = () => {
    const archive = vi.fn(async () => true);
    const remove = vi.fn(async () => undefined);
    return { archive, remove, s: { store: { getState: () => ({ conflicts: {} }) }, workspaces: { archive, remove, manager: { find: () => ws('top', { kind: 'worktree', branch: 'b' }) } } } };
  };

  it('sends the answer on to the Mac’s own archive and delete', async () => {
    const { s, archive, remove } = session();
    await branchStep(s as never, topic, 'archive', 'with');
    expect(archive).toHaveBeenCalledWith('top', false, { children: 'with' });
    await branchStep(s as never, topic, 'delete', 'keep');
    expect(remove).toHaveBeenCalledWith('top', { children: 'keep' });
  });

  it('an older phone sends no answer: the children stay', async () => {
    const { s, archive, remove } = session();
    expect(parseArgs('companion.branchStep', [topic, 'archive'])).toEqual([topic, 'archive']);
    await branchStep(s as never, topic, 'archive');
    expect(archive).toHaveBeenCalledWith('top');
    await branchStep(s as never, topic, 'delete');
    expect(remove).toHaveBeenCalledWith('top');
  });

  it('the view says what each would touch, with the Mac’s counts', () => {
    const st = state([ws('top', { kind: 'worktree', branch: 'b' }), ws('kid', { thread: thread('ws:top') }), ws('old', { thread: thread('ws:top'), archived: true } as Partial<Workspace>)], false, { log: [running('ws:kid')] as never });
    expect(conv(st, 'top').branch?.threads).toEqual({ archive: { count: 1, running: 1 }, delete: { count: 2, running: 1 } });
    expect(conv(state([ws('top', { kind: 'worktree', branch: 'b' })]), 'top').branch?.threads).toBeUndefined();
  });

  it('the phone’s answer: the Mac’s defaults, and none to an older Mac', () => {
    const asked = { count: 2, running: 0 };
    expect(branchChildren(true, asked, true)).toBe('with');
    expect(branchChildren(true, asked, false)).toBe('keep');
    expect(branchChildren(true, undefined, true)).toBeUndefined();
    expect(branchChildren(true, { count: 0, running: 0 }, true)).toBeUndefined();
    expect(branchChildren(false, asked, true)).toBeUndefined();
    expect(calls.branchStep(topic, 'archive', 'Archive').args).toEqual([topic, 'archive']);
    expect(calls.branchStep(topic, 'archive', 'Archive', 'keep').args).toEqual([topic, 'archive', 'keep']);
  });

  it('asks in the Mac’s words', () => {
    expect(threadsQuestion('archive', { count: 1, running: 0 }).label).toBe('Also archive its 1 thread');
    expect(threadsQuestion('delete', { count: 2, running: 1 })).toMatchObject({ label: 'Also delete its 2 threads' });
    expect(threadsQuestion('delete', { count: 2, running: 1 }).detail).toContain('1 is working now and would stop.');
    expect(threadsQuestion('archive', { count: 3, running: 2 }).detail).toContain('2 are working now');
  });
});

describe('the rows of Work', () => {
  const c = (id: string, parent?: string): ConvSummary => ({ topic: `conv:ws:${id}`, title: id, status: 'idle', ...(parent ? { parent: `conv:ws:${parent}` } : {}) }) as ConvSummary;
  const flat = (rows: ReturnType<typeof nestRows>) => rows.map((r) => [r.conv.title, r.depth]);

  it('puts children under their parent, keeping the order', () => {
    expect(flat(nestRows([c('kid', 'top'), c('other'), c('top'), c('grand', 'kid'), c('kid2', 'top')]))).toEqual([['other', 0], ['top', 0], ['kid', 1], ['grand', 2], ['kid2', 1]]);
  });

  it('a child whose parent is not in the list stays a row of its own', () => {
    expect(flat(nestRows([c('kid', 'gone')]))).toEqual([['kid', 0]]);
  });

  it('never loses a row to a loop', () => {
    expect(flat(nestRows([c('a', 'b'), c('b', 'a')])).map(([t]) => t).sort()).toEqual(['a', 'b']);
  });

  it('an older Mac’s rows stay flat', () => {
    expect(flat(nestRows([c('a'), c('b')]))).toEqual([['a', 0], ['b', 0]]);
  });
});
