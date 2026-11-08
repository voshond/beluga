import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, initialState } from '../src/core/store.js';
import { PrefsPatch } from '../src/ipc/api.js';
import { cleanTerminalName, terminalLabel } from '../src/shared/terminal-keys.js';
import { isPosixShell, joinArgs, shellArgs, shellName, splitArgs } from '../src/shared/shells.js';
import { listShells, readShellsFile, scriptShell } from '../src/terminal/shells.js';
import { settingsMenu } from '../src/ui/settings-menus.js';
import { appOf } from './helpers.js';

describe('picking the shell', () => {
  it('names shells the way people know them', () => {
    expect(shellName('/bin/zsh')).toBe('zsh');
    expect(shellName('/opt/homebrew/bin/fish')).toBe('fish');
    expect(shellName('/opt/homebrew/bin/nu')).toBe('Nushell');
    expect(shellName('/usr/local/bin/pwsh')).toBe('PowerShell');
    expect(shellName('/usr/local/bin/myshell')).toBe('myshell');
    expect(isPosixShell('/bin/bash')).toBe(true);
    expect(isPosixShell('/opt/homebrew/bin/fish')).toBe(false);
  });

  it('starts a login shell with your arguments, or not', () => {
    expect(shellArgs({ login: true, extra: [] })).toEqual(['-l']);
    expect(shellArgs({ login: false, extra: ['--norc', '-i'] })).toEqual(['--norc', '-i']);
  });

  it('splits typed arguments like a shell, and joins them back for editing', () => {
    expect(splitArgs('  --rcfile "my rc"  -i ')).toEqual(['--rcfile', 'my rc', '-i']);
    expect(splitArgs("-c 'a b' \"\"")).toEqual(['-c', 'a b', '']);
    expect(splitArgs('')).toEqual([]);
    for (const args of [['--rcfile', 'my rc', '-i'], ['-o', ''], []]) expect(splitArgs(joinArgs(args))).toEqual(args);
  });

  it('lists the installed shells once each, your login shell first', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-shells-'));
    const file = path.join(dir, 'shells');
    writeFileSync(file, ['# List of acceptable shells', '', '/bin/bash', '/bin/csh', '/bin/zsh', '/bin/zsh', '/bin/missing', 'not-a-path'].join('\n'));
    expect(readShellsFile('/bin/sh\n# x\n  /bin/zsh # login\n')).toEqual(['/bin/sh', '/bin/zsh']);
    const installed = new Set(['/bin/bash', '/bin/csh', '/bin/zsh', '/opt/homebrew/bin/fish']);
    const shells = listShells({ shellsFile: file, env: { SHELL: '/bin/zsh' }, extra: ['/opt/homebrew/bin/fish', '/opt/homebrew/bin/nu'], exists: (f) => installed.has(f) });
    expect(shells).toEqual([
      { path: '/bin/zsh', name: 'zsh', isDefault: true },
      { path: '/bin/bash', name: 'bash', isDefault: false },
      { path: '/bin/csh', name: 'csh', isDefault: false },
      { path: '/opt/homebrew/bin/fish', name: 'fish', isDefault: false },
    ]);
  });

  // Not on Windows: Windows runs them in Git Bash (tests/platform-shells.test.ts).
  it.skipIf(process.platform === 'win32')('runs setup and run commands in an sh-like shell even when yours is fish', () => {
    expect(scriptShell('/bin/bash')).toBe('/bin/bash');
    expect(isPosixShell(scriptShell('/opt/homebrew/bin/fish', { SHELL: '/opt/homebrew/bin/fish' }))).toBe(true);
    expect(isPosixShell(scriptShell(undefined, {}))).toBe(true);
  });

  it('shows the choices in the terminal app settings', () => {
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'shell_choices', shells: [{ path: '/bin/zsh', name: 'zsh', isDefault: true }, { path: '/opt/homebrew/bin/fish', name: 'fish', isDefault: false }] });
    store.dispatch({ type: 'prefs', prefs: { shell: '/opt/homebrew/bin/fish', shellLogin: false, shellArgs: ['--private'] } });
    const menu = settingsMenu(appOf(store.getState()), 'terminal');
    expect(menu.options.map((o) => o.label)).toEqual(['○ zsh', '◉ fish', '○ Another shell…', 'Login shell', 'Extra arguments', '‹ Back']);
    expect(menu.options[3]!.hint).toMatch(/^Off/);
    expect(menu.options[4]!.hint).toMatch(/^--private/);
    expect(settingsMenu(appOf(store.getState()), 'workspaces').options.find((o) => o.id === 'sec:terminal')?.hint).toBe('fish · not a login shell · --private');
  });

  // Picking "Login shell" in the Mac app's settings unsets the shell. The change goes over the socket as
  // JSON, which drops an undefined, so "unset" travels as null: the API accepts it and the store clears it.
  it('goes back to the login shell when the settings screen sends null', () => {
    expect(PrefsPatch.parse({ shell: null })).toEqual({ shell: null });
    expect(PrefsPatch.parse({ shell: '/bin/bash' })).toEqual({ shell: '/bin/bash' });
    expect(PrefsPatch.parse(JSON.parse(JSON.stringify({ shell: undefined })))).toEqual({}); // what undefined would have become
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'prefs', prefs: { shell: '/bin/bash' } });
    expect(store.getState().prefs.shell).toBe('/bin/bash');
    store.dispatch({ type: 'prefs', prefs: { shell: null } });
    expect(store.getState().prefs.shell).toBeUndefined();
  });
});

describe('naming terminals', () => {
  it('tidies names and labels tabs with them', () => {
    expect(cleanTerminalName('  dev\n server\t ')).toBe('dev server');
    expect(cleanTerminalName('x'.repeat(80))).toHaveLength(40);
    expect(terminalLabel('shell:3')).toBe('Shell 3');
    expect(terminalLabel('ws1')).toBe('Shell');
    expect(terminalLabel('ws1:setup')).toBe('Setup');
    expect(terminalLabel('ws1:run', { 'ws1:run': 'Dev server' })).toBe('Dev server');
  });

  it('keeps a name while the terminal lives (restarts too) and forgets it when closed', () => {
    const store = new Store(initialState('t'));
    store.dispatch({ type: 'terminal_name', id: 'shell:1', name: 'early' });
    expect(store.getState().termNames).toEqual({}); // not a terminal yet
    store.dispatch({ type: 'terminal', id: 'shell:1', title: 'zsh' });
    store.dispatch({ type: 'terminal_name', id: 'shell:1', name: 'logs' });
    expect(store.getState().termNames).toEqual({ 'shell:1': 'logs' });
    store.dispatch({ type: 'terminal_exit', id: 'shell:1', code: 0 });
    store.dispatch({ type: 'terminal', id: 'shell:1', title: 'zsh' });
    expect(store.getState().termNames).toEqual({ 'shell:1': 'logs' });
    store.dispatch({ type: 'terminal_name', id: 'shell:1' });
    expect(store.getState().termNames).toEqual({});
    store.dispatch({ type: 'terminal_name', id: 'shell:1', name: 'again' });
    store.dispatch({ type: 'terminal', id: 'shell:1' });
    expect(store.getState().termNames).toEqual({});
  });
});
