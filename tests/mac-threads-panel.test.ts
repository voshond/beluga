import { describe, expect, it } from 'vitest';
import { agentMark } from '../src/shared/agent-marks.js';
import type { ThreadRecord } from '../src/shared/threads.js';
import type { Workspace } from '../src/workspaces/types.js';
import type { CcAgent, CcSession } from '../src/core/claude-code/model.js';
import type { SubAgent } from '../packages/mac/src/claude-code/subagents-model.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { type FoldRow, type ThreadFamilyRow, type ThreadFamilySource, capFold, familyRowOf, foldNoun, foldRows, foldRunning, foldSummary, rowEnd, harnessOf, mixedHarnesses, threadFamilyView, openPath, orderRows, panelRows, startedBy, threadNesting, threadSender, threadStarts, threadStateOf } from '../packages/mac/src/threads/threads-model.js';

const thread = (parent: string, startedAt = 1, extra: Partial<ThreadRecord> = {}): ThreadRecord => ({ parent, parentTitle: 'parent', root: parent, depth: 1, task: 't', startedAt, owed: [], ...extra });
const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name: id, kind: 'chat', projectId: 'p', external: false, path: `/${id}`, projectRoot: '/p', createdAt: 1, ...extra }) as Workspace;
const source = (workspaces: Workspace[], on = true, homes: string[] = []): ThreadFamilySource =>
  ({ assistant: { chats: [], active: 'one' }, prefs: { agentThreads: on }, projects: [{ id: 'p', name: 'p', root: '/p', workspaces }], log: [], approvals: [], questions: [], plans: { plans: homes.map((home, i) => ({ id: `plan${i}`, home })) }, board: { issues: [] } }) as unknown as ThreadFamilySource;
const done = (state: 'done' | 'failed' = 'done') => ({ state, summary: 's', at: 2, delivered: true });
const sub = (id: string, startedAt: number): SubAgent => ({ agent: { id, startedAt, status: 'finished' } as CcAgent, session: { id: 's' } as CcSession });
const row = (id: string, startedAt: number, state: 'running' | 'done'): FoldRow => ({ kind: 'thread', ws: ws(id, { thread: thread('ws:top', startedAt) }), state, startedAt });
const ids = (rows: readonly FoldRow[]): string[] => rows.map((r) => (r.kind === 'thread' ? r.ws.id : r.sub.agent.id));

describe('a parent that went', () => {
  const mac = 'mac:assistant:one';
  const withMac = (workspaces: Workspace[], chats: Array<{ channel: string }>): ThreadFamilySource => ({ ...source(workspaces), assistant: { chats, active: 'one' } }) as unknown as ThreadFamilySource;

  it('a thread marked parentGone has no link and no nesting, also when a chat with that id is there', () => {
    const list = [ws('top'), ws('kid', { thread: thread('ws:top', 1, { parentGone: true }) })];
    expect(startedBy(source(list), 'ws:kid')).toEqual({ title: 'parent', gone: true });
    expect(threadNesting(source(list)).nested.has('kid')).toBe(false);
  });

  it('a Your Mac parent is there while its chat is, and gone after', () => {
    const list = [ws('kid', { thread: thread(mac) })];
    expect(startedBy(withMac(list, [{ channel: mac }]), 'ws:kid')).toEqual({ title: 'parent', gone: false });
    expect(startedBy(withMac(list, []), 'ws:kid')).toEqual({ title: 'parent', gone: true });
  });
});

describe('child threads in the sidebar', () => {
  it('nests a child under a live parent in start order, and takes it off the top level', () => {
    const n = threadNesting(source([ws('top'), ws('b', { thread: thread('ws:top', 5) }), ws('a', { thread: thread('ws:top', 2) })]));
    expect([...n.nested].sort()).toEqual(['a', 'b']);
    expect(n.under.get('top')?.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('keeps a child at the top level when its parent has no row', () => {
    const cases: Workspace[][] = [
      [ws('kid', { thread: thread('ws:gone') })],
      [ws('top', { archived: true } as Partial<Workspace>), ws('kid', { thread: thread('ws:top') })],
      [ws('top', { kind: 'main' }), ws('kid', { thread: thread('ws:top') })],
      [ws('top', { projectId: 'other' }), ws('kid', { thread: thread('ws:top') })],
      [ws('kid', { thread: thread('assistant:1') })],
    ];
    for (const list of cases) expect(threadNesting(source(list)).nested.size).toBe(0);
    expect(threadNesting(source([ws('top'), ws('kid', { thread: thread('ws:top') })], true, ['ws:top'])).nested.size).toBe(0);
  });

  it('changes no row with the flag off', () => {
    const list = [ws('top'), ws('kid', { thread: thread('ws:top') })];
    const off = source(list, false);
    expect(threadNesting(off).nested.size).toBe(0);
    expect(harnessOf({ prefs: off.prefs, self: {}, projects: [] } as never, list[0]!)).toBeUndefined();
  });

  it('BLG-345: shows marks only when the chats listed now use two or more harnesses', () => {
    const codex = { runtime: 'codex', label: 'Codex' } as Workspace['agent'];
    const withSelf = (st: ThreadFamilySource): ThreadFamilySource => ({ ...st, self: {} }) as ThreadFamilySource;
    const one = withSelf(source([ws('top'), ws('kid', { thread: thread('ws:top') }), ws('old', { agent: codex, archived: true } as Partial<Workspace>), ws('m', { kind: 'main', agent: codex })]));
    expect(mixedHarnesses(one)).toBe(false);
    expect(harnessOf(one, ws('top'))).toBeUndefined();
    const list = [ws('top'), ws('kid', { thread: thread('ws:top'), agent: codex })];
    const two = withSelf(source(list));
    expect(mixedHarnesses(two)).toBe(true);
    expect(list.map((w) => harnessOf(two, w)?.runtime)).toEqual(['claude', 'codex']);
    expect(mixedHarnesses(withSelf(source(list, false)))).toBe(false);
  });

  it('shows the mark of the chat’s own harness, else your default, and none on a main folder', () => {
    const mixed = [{ id: 'p', workspaces: [ws('a', { agent: { runtime: 'claude', label: 'Claude' } as Workspace['agent'] }), ws('b', { agent: { runtime: 'opencode', label: 'OpenCode' } as Workspace['agent'] })] }];
    const state = { prefs: { agentThreads: true }, self: { defaultAgent: { runtime: 'codex', label: 'Codex' } }, projects: mixed } as never;
    const marks = ['claude', 'codex', 'opencode', 'local'].map((runtime) => agentMark(harnessOf(state, ws('x', { agent: { runtime, label: runtime } as Workspace['agent'] }))));
    expect(marks).toEqual(['claudeCode', 'codex', 'opencode', 'localModel']);
    expect(harnessOf(state, ws('x'))?.runtime).toBe('codex');
    expect(harnessOf(state, ws('x', { kind: 'main' }))).toBeUndefined();
  });

  it('caps five children: finished ones collapse, working ones and the open one stay', () => {
    const rows = [row('a', 1, 'done'), row('b', 2, 'running'), row('c', 3, 'done'), row('d', 4, 'done'), row('e', 5, 'running')];
    expect(capFold(rows, 3, () => false)).toMatchObject({ hidden: 2 });
    expect(ids(capFold(rows, 3, () => false).shown)).toEqual(['b', 'd', 'e']);
    const open = capFold(rows, 3, (r) => r.kind === 'thread' && r.ws.id === 'a');
    expect(ids(open.shown)).toEqual(['a', 'b', 'd', 'e']);
    expect(open.hidden).toBe(1);
  });

  it('caps a list of sub-agents only as it did before', () => {
    const rows = foldRows(['a', 'b', 'c', 'd', 'e'].map((id, i) => sub(id, i)), []);
    const open = capFold(rows, 3, (r) => r.kind === 'agent' && r.sub.agent.id === 'a');
    expect(ids(open.shown)).toEqual(['a', 'c', 'd', 'e']);
    expect(open.hidden).toBe(1);
    expect(foldNoun(rows)).toBe('sub-agents');
    expect(foldSummary(rows)).toBe('5 sub-agents');
  });

  it('merges sub-agents and threads into one fold, by start', () => {
    const rows = foldRows([sub('agent', 2)], [{ ws: ws('kid', { thread: thread('ws:top', 1) }), state: 'running' }]);
    expect(ids(rows)).toEqual(['kid', 'agent']);
    expect(foldNoun(rows)).toBe('threads and sub-agents');
    expect(foldSummary(rows)).toBe('1 thread · 1 sub-agent · 1 running');
  });

  it('gives a native sub-agent and a thread the same row: harness mark, state and kind, in start order, with one running count', () => {
    const top = ws('top', { agent: { runtime: 'codex', label: 'Codex' } as Workspace['agent'] });
    const kid = ws('kid', { thread: thread('ws:top', 1), agent: { runtime: 'opencode', label: 'OpenCode' } as Workspace['agent'] });
    const state = { ...source([top, kid]), self: {}, log: [{ type: 'agent', channel: 'ws:kid', status: 'started', steps: [], subagents: [], text: '', ts: 4 }] } as unknown as ThreadFamilySource;
    const native: SubAgent = { agent: { id: 'native', startedAt: 2, status: 'running', model: 'gpt-5' } as CcAgent, session: { id: 's' } as CcSession };
    const rows = foldRows([native], [{ ws: kid, state: 'running' }]);
    const family = rows.map((r) => familyRowOf(state, top, r));
    expect(family.map((r) => [r.kind, r.id, r.mark, r.runtime, r.state])).toEqual([
      ['thread', 'kid', 'opencode', 'opencode', 'running'],
      ['agent', 'native', 'codex', 'codex', 'running'],
    ]);
    expect(family[1]?.model).toBe('gpt-5');
    expect(foldRunning(rows)).toBe(2);
    expect(foldSummary(rows)).toBe('1 thread · 1 sub-agent · 2 running');
  });

  it('ends a row with its timer while it works, else its word', () => {
    const base: ThreadFamilyRow = { kind: 'agent', id: 'a', title: 'a', state: 'running', mark: 'claudeCode', runtime: 'claude', agent: 'Claude', since: 0 };
    expect(rowEnd(base, 65_000)).toBe('1m');
    expect(rowEnd({ ...base, state: 'needs_you' }, 65_000)).toBe('Needs you');
    expect(rowEnd({ ...base, state: 'done', endedAt: 5 }, 65_000)).toBe('Done');
  });

  it('BLG-344: a thread waiting on the usage limit says so, with the time it goes on', () => {
    const at = new Date(2026, 10, 8, 14, 5).getTime();
    const kid = ws('kid', { thread: thread('ws:top', 1, { limit: { at, summary: 'You hit your Claude plan usage limit' } }) });
    const row = familyRowOf(source([ws('top'), kid]), ws('top'), { kind: 'thread', ws: kid, state: 'waiting_limit', startedAt: 1 });
    expect(row).toMatchObject({ state: 'waiting_limit', resumesAt: at });
    expect(rowEnd(row, at - 3_600_000)).toBe('Waiting · 14:05');
  });

  it('keeps the way down to an open grandchild', () => {
    const n = threadNesting(source([ws('top'), ws('kid', { thread: thread('ws:top') }), ws('grand', { thread: thread('ws:kid') })]));
    expect([...openPath(n, 'grand')].sort()).toEqual(['grand', 'kid']);
    expect(openPath(n, 'top').size).toBe(0);
  });

  it('reads a thread’s state from the log and its record', () => {
    const empty = { log: [], approvals: [], questions: [] } as never;
    expect(threadStateOf(empty, ws('x'))).toBeUndefined();
    expect(threadStateOf(empty, ws('x', { thread: thread('ws:top', 1, { owed: ['r'] }) }))).toBe('queued');
    expect(threadStateOf(empty, ws('x', { thread: thread('ws:top', 1, { outcome: done('failed') }) }))).toBe('failed');
    const running = { log: [{ type: 'agent', channel: 'ws:x', status: 'started', steps: [], subagents: [], text: '' }], approvals: [], questions: [] } as never;
    expect(threadStateOf(running, ws('x', { thread: thread('ws:top', 1, { owed: ['r'] }) }))).toBe('running');
    const asking = { log: [{ type: 'agent', channel: 'ws:x', status: 'started', steps: [], subagents: [], text: '' }], approvals: [], questions: [{ channel: 'ws:x' }] } as never;
    expect(threadStateOf(asking, ws('x', { thread: thread('ws:top', 1) }))).toBe('needs_you');
  });
});

describe('the Threads panel', () => {
  const panel = (workspaces: Workspace[], extra: object = {}): ThreadFamilySource => ({ ...source(workspaces), self: { defaultAgent: { runtime: 'claude', label: 'Claude' } }, ...extra }) as ThreadFamilySource;
  const running = (id: string) => ({ type: 'agent', channel: `ws:${id}`, status: 'started', steps: [], subagents: [], text: '', ts: 1 });

  it('shows nothing with threads off, or for a chat with no family', () => {
    const top = ws('top');
    expect(threadFamilyView(panel([top]), top, [])).toBeUndefined();
    const kid = ws('kid', { thread: thread('ws:top') });
    expect(threadFamilyView({ ...panel([top, kid]), prefs: { agentThreads: false } } as ThreadFamilySource, top, [])).toBeUndefined();
  });

  it('orders needs you, then running, then finished, each in creation order', () => {
    const top = ws('top');
    const kids = [ws('old', { thread: thread('ws:top', 1, { outcome: done() }) }), ws('work', { thread: thread('ws:top', 2) }), ws('ask', { thread: thread('ws:top', 3) }), ws('bad', { thread: thread('ws:top', 4, { outcome: done('failed') }) })];
    const view = threadFamilyView(panel([top, ...kids], { log: [running('work'), running('ask')], questions: [{ channel: 'ws:ask' }] }), top, [sub('native', 9)])!;
    expect(view.rows.map((r) => [r.id, r.state])).toEqual([['ask', 'needs_you'], ['work', 'running'], ['old', 'done'], ['bad', 'failed'], ['native', 'done']]);
    expect(view.running).toBe(2);
    expect(view.rows.find((r) => r.id === 'native')?.kind).toBe('agent');
  });

  it('Stop all reaches every working descendant, deepest first, and no archived or settled one', () => {
    const top = ws('top');
    const list = [top, ws('kid', { thread: thread('ws:top', 1) }), ws('grand', { thread: thread('ws:kid', 2) }), ws('over', { thread: thread('ws:top', 3, { outcome: done() }) }), ws('kept', { thread: thread('ws:top', 4), archived: true } as Partial<Workspace>)];
    const view = threadFamilyView(panel(list, { log: [running('kid'), running('grand'), running('kept')] }), top, [])!;
    expect(view.stoppable).toEqual(['grand', 'kid']);
    expect(view.rows.map((r) => r.id)).toEqual(['kid', 'over']);
    expect(view.running).toBe(1);
  });

  it('the parent row opens the parent; a removed parent keeps its title and opens nothing', () => {
    const top = ws('top', { name: 'Top chat' } as Partial<Workspace>);
    const kid = ws('kid', { thread: { ...thread('ws:top'), parentTitle: 'Old title' } });
    expect(threadFamilyView(panel([top, kid]), kid, [])?.parent).toEqual({ title: 'Top chat', openId: 'top', gone: false });
    expect(threadFamilyView(panel([kid]), kid, [])?.parent).toEqual({ title: 'Old title', gone: true });
    const fromMac = ws('mac', { thread: { ...thread('mac:assistant'), parentTitle: 'Your Mac' } });
    expect(threadFamilyView({ ...panel([fromMac]), assistant: { chats: [{ channel: 'mac:assistant' }], active: 'one' } } as unknown as ThreadFamilySource, fromMac, [])?.parent).toEqual({ title: 'Your Mac', gone: false });
  });

  it('keeps the latest finished rows in view and folds older ones into Earlier', () => {
    const rows = orderRows(['a', 'b', 'c', 'd', 'e'].map((id, i): ThreadFamilyRow => ({ kind: 'thread', id, title: id, state: id === 'e' ? 'running' : 'done', mark: 'codex', runtime: 'codex', agent: 'Codex', since: i })));
    const { shown, earlier } = panelRows(rows, 2, false);
    expect(shown.map((r) => r.id)).toEqual(['e', 'c', 'd']);
    expect(earlier).toBe(2);
    expect(panelRows(rows, 2, true)).toMatchObject({ earlier: 0 });
  });

  it('threads.stop stops one child through the host, and refuses a chat that is no thread', () => {
    const stopped: string[] = [];
    const session = { host: { stopRun: (c: string) => stopped.push(c) }, workspaces: { manager: { find: (id: string) => (id === 'kid' ? ws('kid', { thread: thread('ws:top') }) : ws(id)) } } };
    HANDLERS['threads.stop'](session as never, 'kid');
    expect(stopped).toEqual(['ws:kid']);
    expect(() => HANDLERS['threads.stop'](session as never, 'top')).toThrow('not a child thread');
  });
});

describe('a child chat', () => {
  const state = (workspaces: Workspace[], on = true): ThreadFamilySource => ({ ...source(workspaces, on), self: { defaultAgent: { runtime: 'claude', label: 'Claude' } } }) as ThreadFamilySource;
  const top = ws('top', { name: 'Top chat' } as Partial<Workspace>);
  const kid = ws('kid', { thread: { ...thread('ws:top', 7), parentTitle: 'Old title' }, agent: { runtime: 'codex', label: 'Codex' } as Workspace['agent'] });

  it('says who started it, and a removed parent has no way to open', () => {
    expect(startedBy(state([top, kid]), 'ws:kid')).toEqual({ title: 'Top chat', openId: 'top', gone: false });
    expect(startedBy(state([kid]), 'ws:kid')).toEqual({ title: 'Old title', gone: true });
    expect(startedBy(state([top]), 'ws:top')).toBeUndefined();
    expect(startedBy(state([top, kid], false), 'ws:kid')).toBeUndefined();
  });

  it('labels only the messages the thread tools sent', () => {
    const s = state([top, kid]);
    expect(threadSender(s, { channel: 'ws:kid', byAgent: true, request: 'r1' })).toBe('Top chat');
    expect(threadSender(s, { channel: 'ws:kid', byAgent: true })).toBeUndefined();
    expect(threadSender(s, { channel: 'ws:kid', byAgent: false, request: 'r1' })).toBeUndefined();
    expect(threadSender(s, { channel: 'ws:top', byAgent: true, request: 'r1' })).toBeUndefined();
  });

  it('gives its parent one line for each thread, none with threads off', () => {
    expect(threadStarts(state([top, kid]), 'ws:top')).toEqual([{ id: 'kid', title: 'kid', ts: 7, mark: 'codex', agent: 'Codex' }]);
    expect(threadStarts(state([top, kid], false), 'ws:top')).toEqual([]);
  });
});
