import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSshHosts, sshHostsFrom, sshIncludesFrom } from '../src/core/ssh-hosts.js';
import { SSH_HOST, isOwnShell, isSshShell, sshHostOf, sshShellId, terminalLabel } from '../src/shared/terminal-keys.js';

describe('sshHostsFrom', () => {
  it('lists the named hosts, never patterns or negations', () => {
    const config = ['Host nas', '  HostName 192.168.2.125', 'Host arch m1arch # laptops', 'Host *.internal !bad *', 'Host=box-1', 'Match host foo', '# Host commented'].join('\n');
    expect(sshHostsFrom(config)).toEqual(['nas', 'arch', 'm1arch', 'box-1']);
  });

  it('reads Include lines', () => {
    expect(sshIncludesFrom('Include config.d/*\ninclude ~/.extra "quoted"')).toEqual(['config.d/*', '~/.extra', 'quoted']);
  });
});

describe('readSshHosts', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'ssh-home-'));
    mkdirSync(path.join(home, '.ssh', 'config.d'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('follows includes and drops duplicates', async () => {
    writeFileSync(path.join(home, '.ssh', 'config'), 'Include config.d/*.conf\nHost nas\nHost arch');
    writeFileSync(path.join(home, '.ssh', 'config.d', 'work.conf'), 'Host m1arch\nHost nas');
    writeFileSync(path.join(home, '.ssh', 'config.d', 'skip.txt'), 'Host nope');
    expect(await readSshHosts(home)).toEqual(['nas', 'arch', 'm1arch']);
  });

  it('is empty without a config', async () => {
    rmSync(path.join(home, '.ssh'), { recursive: true });
    expect(await readSshHosts(home)).toEqual([]);
  });
});

describe('ssh shell keys', () => {
  it('names a shell after its host', () => {
    const key = sshShellId('nas');
    expect(isSshShell(key)).toBe(true);
    expect(isOwnShell(key)).toBe(true);
    expect(isOwnShell('shell:2')).toBe(true);
    expect(sshHostOf(key)).toBe('nas');
    expect(terminalLabel(key)).toBe('nas');
  });

  it('refuses hosts that could be ssh options', () => {
    expect(SSH_HOST.test('-oProxyCommand=x')).toBe(false);
    expect(SSH_HOST.test('a b')).toBe(false);
    expect(isSshShell('ssh:-x')).toBe(false);
  });
});
