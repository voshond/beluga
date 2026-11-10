import { describe, expect, it } from 'vitest';
import { shellQuote, substituteParams, extractParamNames, normalizeCommandSig } from '../src/workspaces/toolbox.js';

describe('shellQuote', () => {
  it('passes safe values through', () => {
    expect(shellQuote('hello')).toBe('hello');
    expect(shellQuote('arch')).toBe('arch');
    expect(shellQuote('user@host.example.com')).toBe('user@host.example.com');
  });

  it('wraps values with spaces in single quotes', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
  });

  it('escapes single quotes inside values', () => {
    expect(shellQuote("it's alive")).toBe("'it'\\''s alive'");
  });

  it('wraps empty string as empty single-quoted string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('wraps paths with slashes', () => {
    expect(shellQuote('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('wraps values with shell metacharacters', () => {
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'");
    expect(shellQuote('a;b')).toBe("'a;b'");
    expect(shellQuote('a|b')).toBe("'a|b'");
  });
});

describe('substituteParams', () => {
  it('replaces a single placeholder', () => {
    expect(substituteParams('ssh {{host}}', { host: 'arch' })).toBe('ssh arch');
  });

  it('shell-quotes values with spaces', () => {
    expect(substituteParams('echo {{msg}}', { msg: 'hello world' })).toBe("echo 'hello world'");
  });

  it('shell-quotes values with special characters', () => {
    expect(substituteParams('echo {{v}}', { v: "it's a test" })).toBe("echo 'it'\\''s a test'");
  });

  it('leaves unknown placeholders untouched', () => {
    expect(substituteParams('ssh {{host}} -p {{port}}', { host: 'arch' })).toBe("ssh arch -p {{port}}");
  });

  it('replaces multiple distinct placeholders', () => {
    expect(substituteParams('rsync -a {{src}} {{dst}}', { src: '/home/user/data', dst: 'nas:/volume1/backup' })).toBe('rsync -a /home/user/data nas:/volume1/backup');
  });

  it('replaces the same placeholder multiple times', () => {
    expect(substituteParams('cp {{f}} {{f}}.bak', { f: 'my file.txt' })).toBe("cp 'my file.txt' 'my file.txt'.bak");
  });
});

describe('extractParamNames', () => {
  it('returns empty array for no placeholders', () => {
    expect(extractParamNames('echo hello')).toEqual([]);
  });

  it('returns param names in order of first appearance', () => {
    expect(extractParamNames('ssh {{host}} -l {{user}}')).toEqual(['host', 'user']);
  });

  it('deduplicates repeated placeholders', () => {
    expect(extractParamNames('cp {{f}} {{f}}.bak')).toEqual(['f']);
  });

  it('trims whitespace inside double braces', () => {
    expect(extractParamNames('echo {{ name }}')).toEqual(['name']);
  });
});

describe('normalizeCommandSig', () => {
  it('replaces known home paths with ~', () => {
    expect(normalizeCommandSig('cat /home/voshond/.bashrc')).toBe('cat ~/.bashrc');
    expect(normalizeCommandSig('ls /Users/martin/Documents')).toBe('ls ~/Documents');
  });

  it('replaces known hostnames with <host>', () => {
    expect(normalizeCommandSig('ssh arch')).toBe('ssh <host>');
    expect(normalizeCommandSig('rsync -a . m1arch:/data')).toBe('rsync -a . <host>:/data');
  });

  it('trims whitespace', () => {
    expect(normalizeCommandSig('  ls -la  ')).toBe('ls -la');
  });

  it('truncates long commands at 200 chars', () => {
    const long = 'echo ' + 'x'.repeat(300);
    expect(normalizeCommandSig(long).length).toBeLessThanOrEqual(200);
  });
});
