import { describe, expect, it } from 'vitest';
import { type SidebarSearchSources, matchChats, moveSelection, searchesMessages, sidebarResults } from '../packages/mac/src/layout/sidebar-search-model.js';
import { refusal, shortcutDef, bindingsOf, menuKeys } from '../packages/mac/src/lib/shortcuts-model.js';
import { initialState } from '../src/core/store.js';
import type { SearchHit } from '../src/core/work-store.js';
import type { Plan } from '../src/core/plans/model.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({ id, name, kind: 'worktree', projectId: 'p', external: false, path: `/w/${id}`, branch: `feat/${id}`, ...extra }) as unknown as Workspace;
const project = (name: string, workspaces: Workspace[], extra: Partial<Project> = {}): Project => ({ id: 'p', name, root: '/r', workspaces, ...extra }) as unknown as Project;
const plan = (id: string, title: string, home: string): Plan => ({ id, projectId: 'p', home, status: 'active', body: { title } }) as unknown as Plan;

const base = initialState('r');
const sources = (projects: Project[], extra: Partial<SidebarSearchSources> = {}): SidebarSearchSources => ({ projects, plans: base.plans, shared: [], prs: {}, ...extra });
const ids = (query: string, s: SidebarSearchSources): string[] => matchChats(query, s).map((m) => m.key);

describe('matchChats', () => {
  const all = sources([project('api', [ws('a', 'add-auth'), ws('b', 'fix-billing', { branch: 'hotfix/stripe' })])], {
    prs: { a: { number: 412, title: 'Rotate the tokens' } as never },
  });

  it('finds nothing for a blank query', () => {
    expect(ids('   ', all)).toEqual([]);
  });

  it('finds a worktree by its name, in any case', () => {
    expect(ids('ADD-auth', all)).toEqual(['ws:a']);
  });

  it('finds a worktree by its branch', () => {
    expect(ids('hotfix/str', all)).toEqual(['ws:b']);
  });

  it('finds a worktree by its PR number, with or without #, and by its PR title', () => {
    expect(ids('#412', all)).toEqual(['ws:a']);
    expect(ids('412', all)).toEqual(['ws:a']);
    expect(ids('rotate tokens', all)).toEqual(['ws:a']);
  });

  it('finds every worktree of a project by the project’s name', () => {
    expect(ids('api', all)).toEqual(['ws:a', 'ws:b']);
  });

  it('needs every word, each in any of the fields', () => {
    expect(ids('api billing', all)).toEqual(['ws:b']);
    expect(ids('api nothing', all)).toEqual([]);
  });

  it('puts a name that starts with the word first, then a name with it, then the rest', () => {
    const s = sources([project('pay', [ws('c', 'other', { branch: 'pay-later' }), ws('d', 'repay'), ws('e', 'payments')])]);
    expect(ids('pay', s)).toEqual(['ws:e', 'ws:d', 'ws:c']);
  });

  it('leaves out archived worktrees and a project’s main folder', () => {
    const s = sources([project('api', [ws('a', 'old', { archived: true }), ws('m', 'old main', { kind: 'main' })])]);
    expect(ids('old', s)).toEqual([]);
  });

  it('finds a chat with no project, and its project’s name is not a match', () => {
    const s = sources([project('Chats', [ws('c', 'a question', { kind: 'chat' })], { root: undefined })]);
    expect(ids('question', s)).toEqual(['ws:c']);
    expect(ids('chats', s)).toEqual([]);
  });

  it('finds a plan by its title and its project, and not its conversation again', () => {
    const s = sources([project('api', [ws('h', 'Move billing')])], { plans: { ...base.plans, plans: [plan('pl', 'Move billing', 'ws:h')] } });
    expect(matchChats('billing', s)).toMatchObject([{ key: 'plan:pl', target: { kind: 'plan', id: 'pl' }, label: 'Move billing' }]);
    expect(ids('api', s)).toEqual(['plan:pl']);
  });

  it('finds a chat shared with you by its name, branch and project', () => {
    const shared = [{ owner: 'bob', id: 's', name: 'payments', project: 'bob-api', branch: 'fix-webhooks', role: 'view', share: 'x' }] as never;
    const s = sources([], { shared });
    for (const q of ['payments', 'fix-web', 'bob-api']) expect(matchChats(q, s)).toMatchObject([{ key: 'shared:bob:s', target: { kind: 'shared', owner: 'bob', id: 's' } }]);
  });
});

describe('searchesMessages', () => {
  it('asks only when a word has 3 letters or more', () => {
    expect(searchesMessages('')).toBe(false);
    expect(searchesMessages('ab')).toBe(false);
    expect(searchesMessages('a b cd')).toBe(false);
    expect(searchesMessages('abc')).toBe(true);
    expect(searchesMessages('a abc')).toBe(true);
  });
});

describe('sidebarResults', () => {
  const hit = (ts: number): SearchHit => ({ channel: 'ws:a', place: 'api › a', who: 'k', text: `auth ${ts}`, at: 0, ts });
  const chats = matchChats('auth', sources([project('api', [ws('a', 'auth')])]));

  it('lists the chats, then the messages (keeping each hit’s index), then a way to all of them', () => {
    const rows = sidebarResults('auth', chats, { query: 'auth', hits: [hit(2), hit(1)] });
    expect(rows.map((r) => r.type)).toEqual(['chat', 'message', 'message', 'all']);
    expect(rows.flatMap((r) => (r.type === 'message' ? [r.index] : []))).toEqual([0, 1]);
  });

  it('shows no messages from an earlier search', () => {
    const rows = sidebarResults('auth', chats, { query: 'aut', hits: [hit(2)] });
    expect(rows.map((r) => r.type)).toEqual(['chat', 'all']);
  });

  it('shows no messages for a query too short to search them, whatever was searched before', () => {
    expect(sidebarResults('au', [], { query: 'au', hits: [hit(2)] }).map((r) => r.type)).toEqual(['all']);
  });

  it('caps the messages it shows here', () => {
    const many = Array.from({ length: 200 }, (_, i) => hit(i));
    const rows = sidebarResults('auth', [], { query: 'auth', hits: many });
    expect(rows.filter((r) => r.type === 'message').length).toBeLessThan(50);
  });
});

describe('moveSelection', () => {
  it('moves and wraps around', () => {
    expect(moveSelection(0, 3, 1)).toBe(1);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(0);
  });
});

describe('the shortcut', () => {
  it('is ⌥⌘F, listed under General, free of clashes and in the menu bar', () => {
    expect(shortcutDef('sidebar-search')).toMatchObject({ keys: ['Alt+Cmd+F'], section: 'General', scope: 'app' });
    expect(refusal('sidebar-search', 'Alt+Cmd+F')).toBeUndefined();
    expect(menuKeys(bindingsOf({}))['sidebar-search']).toBe('Alt+CmdOrCtrl+F');
  });
});
