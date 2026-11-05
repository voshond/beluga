import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_MENU, type AppMenuRow, appMenuIds, appearanceOf } from '../packages/mac/src/lib/app-menu-model.js';

/** The menu bar's items, id → label, as src-tauri/src/menu.rs builds them. */
const menuBar = (): Map<string, string> => {
  const src = readFileSync('packages/mac/src-tauri/src/menu.rs', 'utf8');
  return new Map([...src.matchAll(/item\(\s*app,\s*"([a-z-]+)",\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
};

const rows = (list: readonly AppMenuRow[]): AppMenuRow[] => list.flatMap((r) => (r.submenu ? rows(r.submenu) : [r]));

/** A browser's menu-bar button (docs/web.md): the Mac's menu bar, Settings first. */
describe('the browser’s app menu', () => {
  it('starts with Settings, then the two ways to find anything', () => {
    expect(APP_MENU.slice(0, 3).map((r) => r.id)).toEqual(['settings', 'help-keys', 'palette']);
  });

  it('runs only the menu bar’s own items, by their names there', () => {
    const bar = menuBar();
    for (const r of rows(APP_MENU)) expect([r.id, bar.get(r.id!)]).toEqual([r.id, r.label]);
  });

  it('leaves out what does nothing in a browser', () => {
    const ids = appMenuIds();
    for (const id of ['quit', 'check-updates', 'help-log', 'close-window', 'show']) expect(ids).not.toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('knows which rows pick an appearance', () => {
    expect(appearanceOf('appearance-dark')).toBe('dark');
    expect(appearanceOf('appearance-system')).toBe('system');
    expect(appearanceOf('zoom-in')).toBeUndefined();
    expect(appearanceOf(undefined)).toBeUndefined();
  });
});
