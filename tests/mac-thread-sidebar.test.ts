import { describe, expect, it } from 'vitest';
import type { Action, AppState } from '../src/core/store.js';
import type { ChatTriage } from '../src/core/triage/model.js';
import { initialAppState, reduceApp } from '../src/client/screen.js';
import type { ThreadRecord } from '../src/shared/threads.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { categoriesOf } from '../packages/mac/src/layout/attention-model.js';
import { harnessOf, threadsShownUnder } from '../packages/mac/src/threads/threads-model.js';

/** Child threads in the sidebar's categories (BLG-332) and under a parent put off till later (BLG-333). */

const ws = (over: Partial<Workspace>): Workspace => ({ id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', createdAt: 1, projectId: 'p1', external: false, ...over });
const thread = (parent: string, startedAt = 1): ThreadRecord => ({ parent, parentTitle: 'lead', root: parent, depth: 1, task: 't', startedAt, owed: [] });
const api: Project = {
  id: 'p1', name: 'api', root: '/p', base: 'origin/main',
  workspaces: [ws({ id: 'lead', name: 'lead' }), ws({ id: 'kid', name: 'kid', thread: thread('ws:lead', 2) }), ws({ id: 'kid2', name: 'kid2', thread: thread('ws:lead', 3), agent: { runtime: 'codex', label: 'Codex' } })],
};
const apply = (s: AppState, ...actions: Action[]): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const state = (threads: boolean): AppState =>
  apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [api] }, { type: 'prefs', prefs: { chatCategories: true, agentThreads: threads } });
const later = (channel: string, until: number): Action => ({ type: 'triage_set', channel, record: { snoozed: { at: 1, until, seen: [] } } as ChatTriage });
const names = (s: AppState): string[] => Object.values(categoriesOf(s)).flat().map((e) => e.name).sort();

describe('BLG-332: category rows nest child threads and show the harness mark, as the project list does', () => {
  it('shows a child under its parent, not as its own category row, and the parent has a mark', () => {
    const s = state(true);
    expect(names(s)).toEqual(['lead']);
    expect(threadsShownUnder(s, 'lead').map((w) => w.id)).toEqual(['kid', 'kid2']);
    expect(harnessOf(s, api.workspaces[0]!)).toBeDefined();
  });

  it('changes no category row with agentThreads off', () => {
    const s = state(false);
    expect(names(s)).toEqual(['kid', 'kid2', 'lead']);
    expect(threadsShownUnder(s, 'lead')).toEqual([]);
    expect(harnessOf(s, api.workspaces[0]!)).toBeUndefined();
  });
});

describe('BLG-333: Remind Me Later hides a nested child thread too', () => {
  it('hides a child put off till later from under its parent, keeps it in Later, and shows it again when the time ends', () => {
    const until = Date.now() + 3_600_000;
    const s = apply(state(true), later('ws:kid', until));
    expect(threadsShownUnder(s, 'lead').map((w) => w.id)).toEqual(['kid2']);
    expect(categoriesOf(s).snoozed.map((e) => e.name)).toEqual(['kid']);
    expect(threadsShownUnder(s, 'lead', until + 1).map((w) => w.id)).toEqual(['kid', 'kid2']);
  });
});
