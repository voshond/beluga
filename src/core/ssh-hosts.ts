import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SSH_HOST } from '../shared/terminal-keys.js';

const MAX_INCLUDE_DEPTH = 3;

type ConfigLine = { readonly keyword: string; readonly values: readonly string[] };

const configLines = (config: string): ConfigLine[] =>
  config.split(/\r?\n/).flatMap((raw) => {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) return [];
    return [{ keyword: match[1].toLowerCase(), values: match[2].split(/\s+/).map((v) => v.replace(/^"|"$/g, '')) }];
  });

export const sshHostsFrom = (config: string): string[] => configLines(config).flatMap((l) => (l.keyword === 'host' ? l.values.filter((v) => SSH_HOST.test(v)) : []));

export const sshIncludesFrom = (config: string): string[] => configLines(config).flatMap((l) => (l.keyword === 'include' ? [...l.values] : []));

const expandInclude = async (pattern: string, sshDir: string, home: string): Promise<string[]> => {
  const full = pattern.startsWith('~/') ? path.join(home, pattern.slice(2)) : path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern);
  const name = path.basename(full);
  if (!name.includes('*')) return [full];
  const dir = path.dirname(full);
  const matcher = new RegExp(`^${name.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((e) => matcher.test(e)).sort().map((e) => path.join(dir, e));
};

const hostsIn = async (file: string, sshDir: string, home: string, depth: number): Promise<string[]> => {
  const config = await readFile(file, 'utf8').catch(() => '');
  if (!config) return [];
  const own = sshHostsFrom(config);
  if (depth >= MAX_INCLUDE_DEPTH) return own;
  const includes = await Promise.all(sshIncludesFrom(config).map((p) => expandInclude(p, sshDir, home)));
  const nested = await Promise.all(includes.flat().map((f) => hostsIn(f, sshDir, home, depth + 1)));
  return [...own, ...nested.flat()];
};

export const readSshHosts = async (home: string = os.homedir()): Promise<string[]> => {
  const sshDir = path.join(home, '.ssh');
  return [...new Set(await hostsIn(path.join(sshDir, 'config'), sshDir, home, 0))];
};
