import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type ForkSyncOutcome, MainSync } from '../src/core/main-sync.js';
import { syncForkPrompt } from '../src/agent/sync-main.js';
import { type ForkOf, type GhRunner, fetchFork, mergeUpstream, parseForkJson } from '../src/workspaces/github.js';

const KAY = { host: 'github.com', owner: 'kay', repo: 'app', url: 'https://github.com/kay/app' };
const FORK_JSON = JSON.stringify({ fork: true, default_branch: 'main', parent: { name: 'app', default_branch: 'trunk', owner: { login: 'rstagi' } } });
const FORK: ForkOf = { host: 'github.com', owner: 'rstagi', repo: 'app', url: 'https://github.com/rstagi/app', branch: 'trunk', forkBranch: 'main', behind: 3 };

/** gh answering from a table of "args joined by spaces" → output (or an Error to throw), recording what it was asked. */
function fakeGh(answers: Record<string, string | Error>): GhRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = async (args: readonly string[]): Promise<string> => {
    const key = args.join(' ');
    calls.push(key);
    const out = answers[key];
    if (out instanceof Error) throw out;
    if (out === undefined) throw new Error(`gh: not mocked: ${key}`);
    return out;
  };
  return Object.assign(run, { calls });
}

describe('what a fork was made from', () => {
  it('reads the original and both default branches', () => {
    expect(parseForkJson(FORK_JSON, 'github.com')).toEqual({ host: 'github.com', owner: 'rstagi', repo: 'app', url: 'https://github.com/rstagi/app', branch: 'trunk', forkBranch: 'main' });
  });

  it('says null for a repository that is no fork, undefined for what it cannot read', () => {
    expect(parseForkJson(JSON.stringify({ fork: false, default_branch: 'main' }), 'github.com')).toBeNull();
    expect(parseForkJson('not json', 'github.com')).toBeUndefined();
  });

  it('counts the commits the original has that the fork does not (compare across the network)', async () => {
    const gh = fakeGh({ 'api repos/kay/app': FORK_JSON, 'api repos/kay/app/compare/main...rstagi:app:trunk --jq .ahead_by': '3\n' });
    expect(await fetchFork(KAY, gh)).toEqual(FORK);
  });

  it('still knows the fork when the count is unavailable, and asks enterprise hosts by name', async () => {
    const ghe = { ...KAY, host: 'ghe.acme.com', url: 'https://ghe.acme.com/kay/app' };
    const gh = fakeGh({ 'api --hostname ghe.acme.com repos/kay/app': FORK_JSON, 'api --hostname ghe.acme.com repos/kay/app/compare/main...rstagi:app:trunk --jq .ahead_by': new Error('HTTP 404') });
    expect(await fetchFork(ghe, gh)).toEqual({ ...FORK, host: 'ghe.acme.com', url: 'https://ghe.acme.com/rstagi/app', behind: undefined });
  });
});

describe("GitHub's Sync fork (merge-upstream)", () => {
  const call = 'api -X POST repos/kay/app/merge-upstream -f branch=main';
  it('says how GitHub brought the commits in', async () => {
    expect(await mergeUpstream(KAY, 'main', fakeGh({ [call]: JSON.stringify({ merge_type: 'fast-forward' }) }))).toEqual({ kind: 'fast-forward' });
    expect(await mergeUpstream(KAY, 'main', fakeGh({ [call]: JSON.stringify({ merge_type: 'merge' }) }))).toEqual({ kind: 'merge' });
    expect(await mergeUpstream(KAY, 'main', fakeGh({ [call]: JSON.stringify({ merge_type: 'none' }) }))).toEqual({ kind: 'none' });
  });

  it('tells a conflict from any other refusal, in gh’s words', async () => {
    expect(await mergeUpstream(KAY, 'main', fakeGh({ [call]: new Error('gh: There are merge conflicts (HTTP 409)') }))).toEqual({ kind: 'conflict', message: 'There are merge conflicts (HTTP 409)' });
    expect(await mergeUpstream(KAY, 'main', fakeGh({ [call]: new Error('gh: Resource not accessible by integration (HTTP 403)') }))).toEqual({ kind: 'failed', message: 'Resource not accessible by integration (HTTP 403)' });
  });
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'beluga-fork-sync-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/** A clone whose origin (a local bare repository, standing in for the fork on GitHub) got a commit the clone hasn't fetched. */
function cloneBehind(): string {
  const origin = path.join(tmp, `origin-${Math.random().toString(36).slice(2)}.git`);
  const seed = mkdtempSync(path.join(tmp, 'seed-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(seed, 'push', '-q', origin, 'main');
  const clone = mkdtempSync(path.join(tmp, 'clone-'));
  git(clone, 'clone', '-q', origin, '.');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'from the original, synced on GitHub');
  git(seed, 'push', '-q', origin, 'main');
  return clone;
}

function mainSync(gh: GhRunner, root = tmp, fork: ForkOf | null = FORK) {
  const toasts: string[] = [];
  const asked: string[] = [];
  const forks: Array<ForkOf | undefined> = [];
  const sync = new MainSync({
    manager: {
      remoteOf: async () => 'git@github.com:kay/app.git',
      repoProject: () => ({ id: 'p', root, base: 'origin/main', ...(fork ? { fork } : {}) }),
      setFetchState: () => undefined,
      setFork: (_id: string, f: ForkOf | undefined) => void forks.push(f),
    } as never,
    refresh: async () => undefined,
    publish: () => undefined,
    toast: (text) => void toasts.push(text),
    newChat: async () => undefined,
    newWorktree: async (_p, name) => ({ id: `ws-${name}` }) as never,
    armSync: () => undefined,
    askClaude: (prompt) => void asked.push(prompt),
    open: () => undefined,
    ghHosts: () => [],
    gh,
  });
  return { sync, toasts, asked, forks };
}

describe('MainSync.syncFork', () => {
  const call = 'api -X POST repos/kay/app/merge-upstream -f branch=main';

  it('syncs on GitHub, then updates main here, in one toast', async () => {
    const clone = cloneBehind();
    const { sync, toasts, forks } = mainSync(fakeGh({ [call]: JSON.stringify({ merge_type: 'fast-forward' }) }), clone);
    const out: ForkSyncOutcome = await sync.syncFork('p');
    expect(out).toMatchObject({ kind: 'synced', how: 'fast-forward', update: { kind: 'updated', commits: 1 } });
    expect(git(clone, 'log', '-1', '--format=%s', 'main').trim()).toBe('from the original, synced on GitHub');
    expect(toasts).toEqual(['main is up to date (1 new commit) · synced with rstagi/app']);
    expect(forks.at(-1)).toMatchObject({ behind: 0 });
  });

  it('a conflict changes nothing and comes back to decide about; Claude then gets a worktree', async () => {
    const gh = fakeGh({ [call]: new Error('gh: There are merge conflicts (HTTP 409)') });
    const { sync, toasts, asked } = mainSync(gh);
    const out = await sync.syncFork('p');
    expect(out).toEqual({ kind: 'conflict', message: 'Your fork’s main and rstagi/app’s trunk change the same lines, so GitHub couldn’t sync them.' });
    expect(toasts).toEqual([]);
    expect(await sync.syncForkWithClaude('p', out.kind === 'conflict' ? out.message : undefined)).toBe('ws-sync-rstagi');
    expect(asked[0]).toContain('git fetch https://github.com/rstagi/app.git trunk');
    expect(asked[0]).toContain('gh pr create --base main');
  });

  it('says why GitHub refused, and never runs for a project that is no fork', async () => {
    const refused = mainSync(fakeGh({ [call]: new Error('gh: refusing to allow an OAuth App to create or update workflow without `workflow` scope (HTTP 422)') }));
    expect(await refused.sync.syncFork('p')).toMatchObject({ kind: 'failed' });
    expect(refused.toasts[0]).toMatch(/^Couldn’t sync with rstagi\/app: refusing to allow/);
    const gh = fakeGh({ 'api repos/kay/app': JSON.stringify({ fork: false }) });
    expect(await mainSync(gh, tmp, null).sync.syncFork('p')).toEqual({ kind: 'failed', message: 'This project’s origin isn’t a fork on GitHub' });
    expect(gh.calls).toEqual(['api repos/kay/app']);
  });
});

describe('MainSync.learnFork', () => {
  it('remembers a fork, and believes "not a fork" for an hour', async () => {
    const gh = fakeGh({ 'api repos/kay/app': FORK_JSON, 'api repos/kay/app/compare/main...rstagi:app:trunk --jq .ahead_by': '3' });
    const { sync, forks } = mainSync(gh);
    expect(await sync.learnFork('p')).toEqual(FORK);
    expect(forks).toEqual([FORK]);
    const plain = fakeGh({ 'api repos/kay/app': JSON.stringify({ fork: false }) });
    const other = mainSync(plain);
    expect(await other.sync.learnFork('p')).toBeUndefined();
    await other.sync.learnFork('p');
    expect(plain.calls).toEqual(['api repos/kay/app']);
  });
});

describe('the prompt for a conflicted sync', () => {
  it('never pushes to the fork’s branch or to the original', () => {
    const prompt = syncForkPrompt({ original: 'rstagi/app', originalUrl: 'https://github.com/rstagi/app', originalBranch: 'trunk', forkBranch: 'main' });
    expect(prompt).toContain('Never push to main itself, and never to rstagi/app');
    expect(prompt).not.toContain('git remote add');
  });
});
