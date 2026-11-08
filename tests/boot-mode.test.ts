import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIENT_COMMANDS, type NativeRow, REMOTE_APP_PATHS, bootModeOf, commandName, nativePath } from '../packages/mac/src/lib/boot-mode.js';

/** The app, the app as a client of a Beluga server, or a browser (BLG-53), and what each native bit does in each. */

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const docsRows = (): Array<{ key: string; text: string }> => {
  const md = read('docs/web.md');
  const table = md.slice(md.indexOf('| Where (`packages/mac/src/…`)'));
  return table
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split(' | ').at(-1)!.replace(/ \|$/, ''))
    .map((cell) => {
      const [, key = '', text = ''] = /^`(\w+)` (.*)$/.exec(cell) ?? [];
      return { key, text };
    });
};

describe('bootModeOf', () => {
  it('tells the app, the app as a client and a browser apart', () => {
    expect(bootModeOf({ shell: true, protocol: 'tauri:', hostname: 'localhost', dev: false })).toBe('app');
    expect(bootModeOf({ shell: true, protocol: 'http:', hostname: 'tauri.localhost', dev: false })).toBe('app');
    expect(bootModeOf({ shell: true, protocol: 'http:', hostname: 'localhost', dev: true })).toBe('app');
    expect(bootModeOf({ shell: true, protocol: 'https:', hostname: 'i9arch.tail1234.ts.net', dev: false })).toBe('remote-app');
    expect(bootModeOf({ shell: true, protocol: 'http:', hostname: '127.0.0.1', dev: false })).toBe('remote-app');
    expect(bootModeOf({ shell: false, protocol: 'https:', hostname: 'i9arch.tail1234.ts.net', dev: false })).toBe('browser');
    expect(bootModeOf({ shell: false, protocol: 'http:', hostname: 'localhost', dev: true })).toBe('browser');
  });
});

describe('nativePath', () => {
  const rows = Object.keys(REMOTE_APP_PATHS) as NativeRow[];

  it('keeps the app and the browser as they were', () => {
    for (const row of rows) {
      expect(nativePath(row, 'app')).toBe('app');
      expect(nativePath(row, 'browser')).toBe('web');
    }
  });

  it('has the window’s bits follow the app and files follow the server', () => {
    const app = rows.filter((row) => nativePath(row, 'remote-app') === 'app');
    const web = rows.filter((row) => nativePath(row, 'remote-app') === 'web');
    expect(app).toEqual(expect.arrayContaining(['notify', 'clipboard', 'tray', 'raise', 'sounds', 'globalShortcut', 'updates', 'windowActive']));
    expect(web).toEqual(expect.arrayContaining(['pickFolders', 'files', 'saveText', 'chatDrop', 'taskDrop', 'requestPopup', 'endpoint']));
  });

  it('decides every row of docs/web.md’s table, as the docs say', () => {
    const docs = docsRows();
    expect(docs.map((d) => d.key)).toEqual(rows);
    for (const { key, text } of docs) {
      const path = nativePath(key as NativeRow, 'remote-app');
      if (path === 'web') expect(text, key).toMatch(/^the browser's/);
      else expect(text, key).toMatch(/^the (app's|same)/);
    }
  });
});

describe('the commands the server’s page may call', () => {
  it('go through the beluga plugin only in the client', () => {
    expect(commandName('focus_window', 'remote-app')).toBe('plugin:beluga|focus_window');
    expect(commandName('focus_window', 'app')).toBe('focus_window');
  });

  it('are the same list in the screens, build.rs and the shell', () => {
    const build = read('packages/mac/src-tauri/build.rs');
    const listed = [...build.slice(build.indexOf('.commands(&[')).split('])')[0]!.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    const lib = read('packages/mac/src-tauri/src/lib.rs');
    const handler = lib.slice(lib.indexOf('remote::plugin(tauri::generate_handler!['));
    const registered = [...handler.split(']))')[0]!.matchAll(/(?:\w+::)?(\w+)\s*[,\n]/g)].map((m) => m[1]).filter((name) => name !== 'generate_handler');
    expect(listed).toEqual([...CLIENT_COMMANDS]);
    expect(registered).toEqual([...CLIENT_COMMANDS]);
  });
});
