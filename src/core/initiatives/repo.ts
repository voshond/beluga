import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, tryGit } from '../../workspaces/git.js';
import { DEFAULT_INITIATIVES_DIR, INITIATIVE_SLUG } from './model.js';
import { writeText } from './files.js';

const SETTINGS = 'initiatives.json';
const FALLBACK_NAME = 'Beluga';
const FALLBACK_EMAIL = 'beluga@localhost';

const README = `# Initiatives

One folder per initiative, kept by Beluga. Each holds \`initiative.json\` (the source of truth), \`brief.md\`, \`decisions.md\`, \`timeline.md\`, \`people.md\`, \`status.json\`, \`suggestions.json\` and \`sources/\`.

Beluga commits a folder after each check-in and each chat turn that changed it. When the branch tracks a remote, each commit is pushed; a failed push is tried again with the next commit.
`;

const IGNORE = `.beluga/\n*.tmp\n.DS_Store\n`;

const expandHome = (dir: string, home: string): string => (dir === '~' ? home : dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir);

export const repoRootOf = (belugaDir: string, home: string = os.homedir()): string => {
  const fallback = path.join(home, DEFAULT_INITIATIVES_DIR);
  try {
    const saved: { root?: string } = JSON.parse(readFileSync(path.join(belugaDir, SETTINGS), 'utf8'));
    return typeof saved.root === 'string' && saved.root.trim() ? path.resolve(expandHome(saved.root.trim(), home)) : fallback;
  } catch {
    return fallback;
  }
};

export const saveRepoRoot = (belugaDir: string, root: string): void => writeText(path.join(belugaDir, SETTINGS), `${JSON.stringify({ root }, null, 2)}\n`);

const commitArgs = async (root: string): Promise<string[]> => {
  const email = (await tryGit(root, ['config', 'user.email']))?.trim();
  const identity = email ? [] : ['-c', `user.name=${FALLBACK_NAME}`, '-c', `user.email=${FALLBACK_EMAIL}`];
  return [...identity, '-c', 'commit.gpgsign=false'];
};

const isOwnRepo = async (root: string): Promise<boolean> => {
  const top = (await tryGit(root, ['rev-parse', '--show-toplevel']))?.trim();
  return Boolean(top) && path.resolve(top!) === path.resolve(root);
};

export const ensureRepo = async (root: string): Promise<void> => {
  mkdirSync(root, { recursive: true });
  if (!existsSync(path.join(root, 'README.md'))) writeText(path.join(root, 'README.md'), README);
  if (!existsSync(path.join(root, '.gitignore'))) writeText(path.join(root, '.gitignore'), IGNORE);
  if (await isOwnRepo(root)) return;
  await git(root, ['init', '--quiet']);
  await git(root, ['add', '--', 'README.md', '.gitignore']);
  await git(root, [...(await commitArgs(root)), 'commit', '--quiet', '-m', 'Initiatives'], 60_000);
};

export type PushResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type OnPush = (result: PushResult) => void;

const PUSH_ERROR_MAX = 240;

const pushError = (err: Error): string => {
  const line = err.message.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /^(fatal|error|remote):/i.test(l)) ?? err.message.trim();
  return line.slice(0, PUSH_ERROR_MAX) || 'git push failed';
};

export const pushIfTracked = async (root: string): Promise<PushResult | undefined> => {
  const upstream = await tryGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream?.trim()) return undefined;
  try {
    await git(root, ['push', '--quiet'], 120_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: pushError(err instanceof Error ? err : new Error(String(err))) };
  }
};

export const unpushedCount = async (root: string): Promise<number> => {
  const count = await tryGit(root, ['rev-list', '--count', '@{u}..HEAD']);
  return Number(count?.trim()) || 0;
};

const queues = new Map<string, Promise<boolean>>();

export const commitFolder = (root: string, slug: string, message: string, onPush?: OnPush): Promise<boolean> => {
  if (!INITIATIVE_SLUG.test(slug)) return Promise.resolve(false);
  const commit = async (): Promise<boolean> => {
    if (!existsSync(path.join(root, slug))) return false;
    await git(root, ['add', '-A', '--', slug]);
    const changed = (await git(root, ['diff', '--cached', '--name-only', '--', slug])).trim();
    if (!changed) return false;
    await git(root, [...(await commitArgs(root)), 'commit', '--quiet', '-m', message, '--', slug]);
    const pushed = await pushIfTracked(root);
    if (pushed) onPush?.(pushed);
    return true;
  };
  const previous = queues.get(root) ?? Promise.resolve(false);
  const next = previous.then(commit, commit);
  queues.set(root, next.catch(() => false));
  return next;
};

export const dayOf = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
