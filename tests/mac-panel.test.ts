import { describe, expect, it } from 'vitest';
import type { View } from '../src/core/store.js';
import {
  DRAWER_MAX,
  PANEL_MIN,
  REMEMBERED_TABS,
  clampPanelWidth,
  clampShare,
  drawerFits,
  DEFAULT_LAYOUT,
  moveTab,
  normalizeLayout,
  paneKey,
  paneOf,
  paneTabs,
  viewsOf,
  migratePrefs,
  panelDigit,
  panelKey,
  panelFits,
  panelTabsFor,
  pickPanelTab,
  rememberTab,
} from '../packages/mac/src/lib/panel-model.js';
import { ancestorsOf, foundRows, nameRanges, treeRows, type Entry } from '../packages/mac/src/layout/panel/tree.js';

const ws: View = { kind: 'workspace', id: 'w1', tab: 'chat' };
const room: View = { kind: 'room' };

describe('the right panel’s two panes', () => {
  it('starts with what Claude made on top and what runs below; History is Changes’ second view', () => {
    const all = panelTabsFor(ws, 'worktree');
    expect(paneTabs(DEFAULT_LAYOUT, 'top', all)).toEqual(['changes', 'files', 'scratch', 'info']);
    expect(paneTabs(DEFAULT_LAYOUT, 'bottom', all)).toEqual(['terminal', 'background']);
    expect(viewsOf('changes', all)).toEqual(['changes', 'history']);
    expect(viewsOf('history', all)).toEqual(['changes', 'history']);
    // A project's home has History where Changes would be (and its main folder's Files); a chat has no Changes at all.
    expect(paneTabs(DEFAULT_LAYOUT, 'top', panelTabsFor({ kind: 'project', id: 'p' }))).toEqual(['history', 'files', 'info']);
    expect(paneTabs(DEFAULT_LAYOUT, 'top', panelTabsFor(ws, 'chat'))).toEqual(['files', 'scratch', 'info']);
  });

  it('a tab dragged across stays there, before the tab it was dropped on', () => {
    const moved = moveTab(DEFAULT_LAYOUT, 'info', 'bottom', 'background');
    expect(moved).toEqual({ top: ['changes', 'files', 'scratch', 'phone'], bottom: ['terminal', 'info', 'background'] });
    expect(paneOf(moved, 'info')).toBe('bottom');
    // History moves with Changes.
    expect(moveTab(DEFAULT_LAYOUT, 'history', 'bottom').bottom).toEqual(['terminal', 'background', 'changes']);
    expect(moveTab(DEFAULT_LAYOUT, 'files', 'top')).toEqual({ top: ['changes', 'scratch', 'info', 'phone', 'files'], bottom: ['terminal', 'background'] });
  });

  it('a saved layout is made whole: every tab once, nothing unknown', () => {
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout({ top: ['terminal', 'nope', 'terminal'], bottom: ['terminal', 'files'] })).toEqual({ top: ['terminal', 'changes', 'scratch', 'info', 'phone'], bottom: ['files', 'background'] });
    expect(paneKey(ws, 'bottom')).toBe('ws:w1|bottom');
  });
});

describe('the right panel’s tabs', () => {
  it('a plan’s page has no panel: its chat is its right side', () => {
    expect(panelFits({ kind: 'plan', id: 'p1' })).toBe(false);
    expect(panelTabsFor({ kind: 'plan', id: 'p1' })).toEqual([]);
    expect(panelFits(ws)).toBe(true);
  });
  it('the Tasks board, a task’s page and the plans have the whole window', () => {
    expect(panelFits({ kind: 'task', id: 't1' })).toBe(false);
    expect(panelFits({ kind: 'plans' })).toBe(false);
    // Usage is a page of its own to look at: the whole window (BLG-759).
    expect(panelFits({ kind: 'usage' })).toBe(false);
    expect(panelTabsFor({ kind: 'task', id: 't1' })).toEqual([]);
    expect(panelFits({ kind: 'tasks' })).toBe(false);
    expect(panelTabsFor({ kind: 'tasks' })).toEqual([]);
  });
  it('a workspace has every tab; a chat has no Changes; a friend’s workspace Info and its Scratch; the Terminal view only Info', () => {
    expect(panelTabsFor(ws, 'worktree')).toEqual(['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background']);
    expect(panelTabsFor({ kind: 'project', id: 'p' })).toEqual(['files', 'terminal', 'info', 'history']);
    expect(panelTabsFor(ws, 'chat')).toEqual(['files', 'terminal', 'info', 'scratch', 'background']);
    expect(panelTabsFor({ kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toEqual(['info', 'scratch']);
    expect(panelTabsFor({ kind: 'terminal' })).toEqual(['info']);
    expect(panelTabsFor(room)).toEqual(['terminal', 'info']);
  });
  it('with a phone paired, its mirror is a tab beside Your Mac only, never a project’s chat, the Phone page or a plan', () => {
    expect(panelTabsFor(ws, 'worktree', true)).not.toContain('phone');
    expect(panelTabsFor(ws, 'chat', true)).not.toContain('phone');
    expect(panelTabsFor(room, undefined, true)).not.toContain('phone');
    expect(panelTabsFor({ kind: 'assistant' }, undefined, true)).toEqual(['terminal', 'info', 'scratch', 'phone']);
    expect(panelTabsFor({ kind: 'assistant' })).toEqual(['terminal', 'info', 'scratch']);
    expect(panelTabsFor({ kind: 'phone' }, undefined, true)).toEqual(['terminal', 'info']);
    expect(panelTabsFor({ kind: 'plan', id: 'p1' }, undefined, true)).toEqual([]);
    expect(paneTabs(DEFAULT_LAYOUT, 'top', panelTabsFor({ kind: 'assistant' }, undefined, true))).toEqual(['scratch', 'info', 'phone']);
  });

  it('opens on the tab you last picked there, else Changes when there are changes, else Info', () => {
    const tabs = panelTabsFor(ws, 'worktree');
    expect(pickPanelTab(tabs, 'files', true)).toBe('files');
    expect(pickPanelTab(tabs, undefined, true)).toBe('changes');
    expect(pickPanelTab(tabs, undefined, false)).toBe('info');
    // A remembered tab the view doesn't have is ignored.
    expect(pickPanelTab(['terminal', 'info'], 'changes', true)).toBe('info');
  });

  it('remembers per workspace, one for the rest, and forgets the oldest', () => {
    expect(panelKey(ws)).toBe('ws:w1');
    expect(panelKey(room)).toBe('app');
    let map = {};
    for (let i = 0; i < REMEMBERED_TABS + 5; i++) map = rememberTab(map, `ws:${i}`, 'files');
    expect(Object.keys(map)).toHaveLength(REMEMBERED_TABS);
    expect(map).not.toHaveProperty('ws:0');
    expect(Object.keys(rememberTab(map, 'ws:3', 'info')).pop()).toBe('ws:3');
  });

  it('has fixed ⌥⌘ digits', () => {
    expect(['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background'].map((t) => panelDigit(t as 'changes'))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is never narrower than the minimum nor wider than 60% of the window, and leaves the center its room', () => {
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN);
    // A wide window: 60% of it.
    expect(clampPanelWidth(4000, 2560)).toBe(1536);
    // Narrower: the center keeps its 690 (CENTER_MIN) first, beside the sidebar too.
    expect(clampPanelWidth(2000, 1440)).toBe(750);
    expect(clampPanelWidth(2000, 1440, 240)).toBe(510);
    expect(clampPanelWidth(400, 1440)).toBe(400);
    // A tiny window still gets the minimum.
    expect(clampPanelWidth(400, 400)).toBe(PANEL_MIN);
    expect(clampShare(Number.NaN, 0.2, 0.7)).toBe(0.2);
  });

  it('the drawer goes under anything but the Terminal view and a friend’s workspace', () => {
    expect(drawerFits(ws)).toBe(true);
    expect(drawerFits(room)).toBe(true);
    expect(drawerFits({ kind: 'terminal' })).toBe(false);
    expect(drawerFits({ kind: 'shared', owner: 'o', id: 'x', tab: 'chat' })).toBe(false);
  });
});

describe('preferences from earlier versions', () => {
  it('a terminal docked beside the chat becomes the panel’s Terminal tab', () => {
    expect(migratePrefs({ dock: 'right', dockSize: 0.5, sidebar: true })).toEqual({ termIn: 'panel', drawerSize: 0.5, sidebar: true });
  });

  it('one docked under the chat becomes the open drawer at the same height', () => {
    expect(migratePrefs({ dock: 'bottom', dockSize: 0.9 })).toEqual({ termIn: 'drawer', drawer: true, drawerSize: DRAWER_MAX });
  });

  it('a closed dock keeps the defaults, and new preferences are left alone', () => {
    expect(migratePrefs({ dock: 'off', dockSize: 0.42 })).toEqual({ drawerSize: 0.42 });
    const current = { termIn: 'drawer', drawer: false };
    expect(migratePrefs(current)).toBe(current);
  });
});

describe('the Files tab’s tree', () => {
  const fs: Record<string, Entry[]> = {
    '': [
      { name: 'src', dir: true },
      { name: 'node_modules', dir: true },
      { name: 'README.md', dir: false, size: 10 },
    ],
    src: [
      { name: 'lib', dir: true },
      { name: 'server.ts', dir: false, size: 5 },
    ],
    'src/lib': [{ name: 'auth.ts', dir: false }],
    node_modules: [{ name: 'server-thing', dir: true }],
  };
  it('shows opened folders under their parent, with a loading row for one on its way', () => {
    const rows = treeRows((p) => (p === 'src/lib' ? undefined : fs[p]), new Set(['src', 'src/lib']));
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'loading' ? '…' : r.name}`)).toEqual(['src', '  lib', '    …', '  server.ts', 'node_modules', 'README.md']);
    expect(rows[0]).toMatchObject({ dir: true, open: true });
  });

  it('lays the files a name search found out as a tree, folders first, with the match marked in the name', () => {
    const rows = foundRows([
      { path: 'src/server.ts', ranges: [[4, 7]] },
      { path: 'README.md', ranges: [[0, 3]] },
      { path: 'src/lib/auth.ts', ranges: [[0, 3]] },
    ]);
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual(['src', '  lib', '    auth.ts', '  server.ts', 'README.md']);
    expect(rows.every((r) => !r.dir || r.open)).toBe(true);
    expect(rows.find((r) => r.name === 'server.ts')?.marks).toEqual([[0, 3]]);
    // A match only in the folders above: nothing to mark in the name.
    expect(rows.find((r) => r.name === 'auth.ts')?.marks).toEqual([]);
  });

  it('clips a path’s matches to its name', () => {
    expect(nameRanges('a/bc/def.ts', [[2, 8]])).toEqual([[0, 3]]);
    expect(nameRanges('top.ts', [[1, 2]])).toEqual([[1, 2]]);
  });

  it('knows the folders above a path', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('top.ts')).toEqual([]);
  });
});
