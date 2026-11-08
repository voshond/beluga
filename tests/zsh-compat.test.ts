import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildShellAppend } from '../src/agent/prompt.js';
import { ZSH_COMPAT, ZSH_COMPAT_FILE, zshCompatEnv } from '../src/agent/runtime/claude/zsh-compat.js';

const home = (): string => mkdtempSync(path.join(os.tmpdir(), 'zsh-compat-'));

const ZSH = ['/bin/zsh', '/usr/bin/zsh'].find((file) => existsSync(file));

/** Agents write bash, and Claude Code runs it in your login shell: zsh stopped whole commands on bash habits. */
describe('zsh compat for Claude runs', () => {
  it('points CLAUDE_ENV_FILE at a file it writes in Beluga’s home', () => {
    const dir = home();
    const env = zshCompatEnv({}, dir);
    expect(env.CLAUDE_ENV_FILE).toBe(path.join(dir, ZSH_COMPAT_FILE));
    expect(readFileSync(env.CLAUDE_ENV_FILE!, 'utf8')).toBe(ZSH_COMPAT);
  });

  it('rewrites a file that drifted', () => {
    const dir = home();
    writeFileSync(path.join(dir, ZSH_COMPAT_FILE), 'old');
    zshCompatEnv({}, dir);
    expect(readFileSync(path.join(dir, ZSH_COMPAT_FILE), 'utf8')).toBe(ZSH_COMPAT);
  });

  it('leaves your own CLAUDE_ENV_FILE alone', () => {
    expect(zshCompatEnv({ CLAUDE_ENV_FILE: '/x/env.sh' }, home())).toEqual({});
  });

  it.skipIf(!ZSH)('makes zsh take bash habits the way bash does', () => {
    const script = 'a=x; l="1 2 3"; arr=(p q); for i in $l; do printf "[%s]" $i; done; echo; [ "$a" == x ] && echo eq; echo ${arr[0]}; echo nope*.zzz; echo "a\\nb"';
    const out = execFileSync(ZSH!, ['-c', `${ZSH_COMPAT}${script}`], { encoding: 'utf8', cwd: home() });
    expect(out).toBe('[1][2][3]\neq\np\nnope*.zzz\na\\nb\n');
  });

  it('does nothing in bash', () => {
    const out = execFileSync('/bin/sh', ['-c', `${ZSH_COMPAT}echo ok`], { encoding: 'utf8' });
    expect(out).toBe('ok\n');
  });
});

describe('the shell piece of the prompt', () => {
  it('tells agents on zsh how to write for it', () => {
    const said = buildShellAppend('/usr/bin/zsh', 'linux').replace(/\s+/g, ' ');
    expect(said).toContain('Your shell commands run in zsh, not bash.');
    expect(said).toContain('quote globs and URLs');
    expect(said).toContain('never name a variable `path`');
  });

  it.each([
    ['/bin/bash', 'linux'],
    ['/usr/bin/fish', 'darwin'],
    ['', 'linux'],
    ['C:\\Program Files\\Git\\bin\\zsh.exe', 'win32'],
  ] as const)('says nothing for %s on %s', (shell, platform) => {
    expect(buildShellAppend(shell, platform)).toBe('');
  });
});
