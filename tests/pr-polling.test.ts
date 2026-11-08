import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store, initialState } from '../src/core/store.js';
import type { PullRequest } from '../src/core/work-store.js';
import type { NoticeEvent } from '../src/core/notify.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { PR_FAST_MS, PR_SLOW_MS, Workbench, prCadence, prNews } from '../src/core/workbench.js';
import { parseChecks, parsePr, parsePrList, remoteRef } from '../src/workspaces/pr.js';

/** Shaped like real `gh pr list --state all --json number,url,state,title,isDraft,statusCheckRollup,reviewDecision,headRefName` output. */
const GH_LIST = [
  {
    headRefName: 'klaud/auth',
    isDraft: false,
    number: 70,
    reviewDecision: '',
    state: 'OPEN',
    statusCheckRollup: [
      { __typename: 'CheckRun', completedAt: '2026-10-21T21:21:02Z', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/11', name: 'test', startedAt: '2026-10-21T21:19:55Z', status: 'COMPLETED', workflowName: 'CI' },
      { __typename: 'CheckRun', completedAt: '0001-01-01T00:00:00Z', conclusion: '', detailsUrl: 'https://github.com/o/r/actions/runs/2/job/22', name: 'mac', startedAt: '2026-10-21T21:20:00Z', status: 'IN_PROGRESS', workflowName: 'Mac app' },
      { __typename: 'StatusContext', context: 'ci/vercel', state: 'PENDING', targetUrl: 'https://vercel.com/x', startedAt: '2026-10-21T21:19:00Z' },
    ],
    title: 'Add auth',
    url: 'https://github.com/o/r/pull/70',
  },
  { headRefName: 'klaud/auth', isDraft: false, number: 61, reviewDecision: '', state: 'CLOSED', statusCheckRollup: [], title: 'Old try', url: 'https://github.com/o/r/pull/61' },
  { headRefName: 'klaud/old', isDraft: false, number: 50, reviewDecision: 'APPROVED', state: 'MERGED', statusCheckRollup: [], title: 'Old', url: 'https://github.com/o/r/pull/50' },
  { headRefName: 'klaud/old', isDraft: false, number: 55, reviewDecision: '', state: 'CLOSED', statusCheckRollup: [], title: 'Old again', url: 'https://github.com/o/r/pull/55' },
];

describe('parseChecks', () => {
  it('keeps each check with its name, state, conclusion, link and times', () => {
    expect(parseChecks(GH_LIST[0]!.statusCheckRollup)).toEqual([
      { name: 'test', workflow: 'CI', state: 'completed', conclusion: 'success', url: 'https://github.com/o/r/actions/runs/1/job/11', startedAt: '2026-10-21T21:19:55Z', completedAt: '2026-10-21T21:21:02Z' },
      { name: 'mac', workflow: 'Mac app', state: 'in_progress', url: 'https://github.com/o/r/actions/runs/2/job/22', startedAt: '2026-10-21T21:20:00Z' },
      { name: 'ci/vercel', state: 'in_progress', url: 'https://vercel.com/x', startedAt: '2026-10-21T21:19:00Z' },
    ]);
  });

  it('maps commit statuses and queued runs', () => {
    expect(parseChecks([{ __typename: 'StatusContext', context: 'lint', state: 'FAILURE' }, { __typename: 'StatusContext', context: 'cla', state: 'EXPECTED' }, { __typename: 'CheckRun', name: 'e2e', status: 'QUEUED' }])).toEqual([
      { name: 'lint', state: 'completed', conclusion: 'failure' },
      { name: 'cla', state: 'queued' },
      { name: 'e2e', state: 'queued' },
    ]);
    expect(parseChecks(undefined)).toEqual([]);
  });

  it('keeps at most 100', () => {
    expect(parseChecks(Array.from({ length: 150 }, (_, i) => ({ name: `job ${i}`, status: 'QUEUED' })))).toHaveLength(100);
  });

  it('rides along on the parsed PR, next to the rolled-up value', () => {
    const pr = parsePr(JSON.stringify(GH_LIST[0]));
    expect(pr?.checks).toBe('pending');
    expect(pr?.checkRuns?.map((c) => c.name)).toEqual(['test', 'mac', 'ci/vercel']);
  });
});

describe('parsePrList', () => {
  it("picks each branch's open PR, or else its newest", () => {
    const prs = parsePrList(JSON.stringify(GH_LIST))!;
    expect([...prs.keys()]).toEqual(['klaud/auth', 'klaud/old']);
    expect(prs.get('klaud/auth')).toMatchObject({ number: 70, state: 'OPEN', checks: 'pending' });
    expect(prs.get('klaud/old')).toMatchObject({ number: 55, state: 'CLOSED' });
  });

  it('is undefined for anything but a list, and skips broken entries', () => {
    expect(parsePrList('nope')).toBeUndefined();
    expect(parsePrList('{}')).toBeUndefined();
    expect(parsePrList(JSON.stringify([null, { number: 1 }, { number: 2, url: 'u', headRefName: 'b' }]))!.get('b')?.number).toBe(2);
  });
});

describe('prCadence', () => {
  const open: PullRequest = { number: 1, url: 'u', state: 'OPEN', title: 'T', draft: false, checks: 'passing' };
  it('looks every 15s while checks run, 60s otherwise, never once merged or closed', () => {
    expect(prCadence({ ...open, checks: 'pending' }, undefined, 0)).toBe(PR_FAST_MS);
    expect(prCadence(open, undefined, 0)).toBe(PR_SLOW_MS);
    expect(prCadence(undefined, undefined, 0)).toBe(PR_SLOW_MS);
    expect(prCadence({ ...open, state: 'MERGED' }, undefined, 0)).toBeUndefined();
    expect(prCadence({ ...open, state: 'CLOSED' }, undefined, 0)).toBeUndefined();
    expect([PR_FAST_MS, PR_SLOW_MS]).toEqual([15_000, 60_000]);
  });

  it('looks every 15s for a few minutes after a push', () => {
    expect(prCadence(open, 1000, 1000 + 60_000)).toBe(PR_FAST_MS);
    expect(prCadence(undefined, 1000, 1000 + 60_000)).toBe(PR_FAST_MS);
    expect(prCadence({ ...open, state: 'MERGED' }, 1000, 1000 + 60_000)).toBe(PR_FAST_MS);
    expect(prCadence(open, 1000, 1000 + 4 * 60_000)).toBe(PR_SLOW_MS);
  });
});

describe('prNews', () => {
  const open: PullRequest = { number: 4, url: 'u', state: 'OPEN', title: 'T', draft: false, checks: 'passing' };
  it('tells you a PR was closed, as well as merged', () => {
    expect(prNews('auth', 'ws:a', open, { ...open, state: 'CLOSED' }).map((e) => e.title)).toEqual(['PR #4 was closed without merging']);
    expect(prNews('auth', 'ws:a', open, { ...open, state: 'MERGED' }).map((e) => e.title)).toEqual(['PR #4 was merged']);
    expect(prNews('auth', 'ws:a', { ...open, state: 'CLOSED' }, { ...open, state: 'CLOSED' })).toEqual([]);
  });
});

describe('remoteRef', () => {
  it("reads a linked worktree's remote-tracking ref, which moves when it's pushed", () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ref-')));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', path.join(base, 'origin.git')]);
    const dir = path.join(base, 'app');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    writeFileSync(path.join(dir, 'a'), '1');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'one');
    git(dir, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
    const wt = path.join(base, 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'klaud/x', wt);
    expect(remoteRef(wt, 'klaud/x')).toBeUndefined();
    git(wt, 'push', '-q', '-u', 'origin', 'klaud/x');
    const first = remoteRef(wt, 'klaud/x');
    expect(first).toBe(git(wt, 'rev-parse', 'HEAD'));
    writeFileSync(path.join(wt, 'a'), '2');
    git(wt, 'commit', '-qam', 'two');
    git(wt, 'push', '-q');
    expect(remoteRef(wt, 'klaud/x')).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(remoteRef(wt, 'klaud/x')).not.toBe(first);
    // The main checkout (a .git folder) reads the same refs.
    expect(remoteRef(dir, 'klaud/x')).toBe(git(wt, 'rev-parse', 'HEAD'));
    // After `git gc` / `git pack-refs` the ref lives only in packed-refs.
    git(dir, 'pack-refs', '--all');
    expect(existsSync(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'klaud', 'x'))).toBe(false);
    expect(remoteRef(wt, 'klaud/x')).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(remoteRef(wt, 'klaud/y')).toBeUndefined();
  });
});

/** A Workbench over fake worktrees, a fake gh and a hand-moved clock. */
function bench(worktrees: Array<{ id: string; branch: string; project?: string; ahead?: number; path?: string }>) {
  const store = new Store(initialState('t', 'ask'));
  const workspaces = worktrees.map((w) => ({ id: w.id, name: w.id, kind: 'worktree', branch: w.branch, path: w.path ?? `/code/${w.id}`, projectId: w.project ?? 'p1', status: { changed: 0, ahead: w.ahead ?? 1, behind: 0 } }));
  const projects = [...new Set(workspaces.map((w) => w.projectId))];
  const manager = { list: projects.map((id) => ({ id, workspaces: workspaces.filter((w) => w.projectId === id) })), find: (id: string) => workspaces.find((w) => w.id === id) };
  const remote: Record<string, string | undefined> = {};
  const gh = new Map<string, PullRequest>();
  const calls: string[] = [];
  let running = 0;
  let most = 0;
  const notices: NoticeEvent[] = [];
  const clock = { now: 1_000_000 };
  const slow = async <T>(value: T): Promise<T> => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return value;
  };
  const wb = new Workbench({
    store,
    controller: { manager } as unknown as WorkspaceController,
    notify: (e) => void notices.push(e),
    toast: () => undefined,
    intend: () => undefined,
    askClaude: () => undefined,
    setPrefs: () => undefined,
    hasGh: async () => true,
    findPr: async (dir, branch) => (calls.push(`view ${branch}`), slow(gh.get(branch))),
    listPrs: async (dir) => (calls.push(`list ${dir}`), slow({ prs: new Map(gh), full: false })),
    remoteRef: (_dir, branch) => remote[branch],
    now: () => clock.now,
  });
  store.dispatch({ type: 'gh', ok: true });
  return { wb, store, gh, calls, remote, notices, clock, most: () => most, prs: () => store.getState().prs };
}

const pr = (number: number, more: Partial<PullRequest> = {}): PullRequest => ({ number, url: `u/${number}`, state: 'OPEN', title: `PR ${number}`, draft: false, checks: 'passing', ...more });

describe('PR polling', () => {
  it('asks once per project with several worktrees, three calls at a time', async () => {
    const b = bench([
      { id: 'a', branch: 'klaud/a' },
      { id: 'b', branch: 'klaud/b' },
      ...['c', 'd', 'e', 'f'].map((id) => ({ id, branch: `klaud/${id}`, project: `solo-${id}` })),
    ]);
    b.gh.set('klaud/a', pr(1));
    b.gh.set('klaud/c', pr(3));
    await b.wb.refreshPrs();
    expect(b.calls.filter((c) => c.startsWith('list'))).toEqual(['list /code/a']);
    expect(b.calls.filter((c) => c.startsWith('view')).sort()).toEqual(['view klaud/c', 'view klaud/d', 'view klaud/e', 'view klaud/f']);
    expect(b.most()).toBe(3);
    expect(b.prs().a?.number).toBe(1);
    expect(b.prs().b).toBeUndefined();
    expect(b.prs().c?.number).toBe(3);
  });

  it("asks about a fork's PR checked out here by its number, by itself: origin's list has it under the fork's branch", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-pull-')));
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['config', 'branch.pr-7.remote', 'origin'], { cwd: dir });
    execFileSync('git', ['config', 'branch.pr-7.merge', 'refs/pull/7/head'], { cwd: dir });
    const b = bench([
      { id: 'a', branch: 'klaud/a' },
      { id: 'b', branch: 'klaud/b' },
      { id: 'fork', branch: 'pr-7', path: dir },
    ]);
    b.gh.set('pr-7', pr(7));
    await b.wb.refreshPrs();
    expect(b.calls.filter((c) => c.startsWith('list'))).toEqual(['list /code/a']);
    expect(b.calls.filter((c) => c.startsWith('view'))).toEqual(['view pr-7']);
    expect(b.prs().fork?.number).toBe(7);
  });

  it('looks at pending PRs every 15s, open ones every 60s, merged ones never', async () => {
    const b = bench([
      { id: 'run', branch: 'klaud/run', project: 'x' },
      { id: 'idle', branch: 'klaud/idle', project: 'y' },
      { id: 'done', branch: 'klaud/done', project: 'z' },
    ]);
    b.gh.set('klaud/run', pr(1, { checks: 'pending' }));
    b.gh.set('klaud/idle', pr(2));
    b.gh.set('klaud/done', pr(3, { state: 'MERGED' }));
    await b.wb.refreshPrs();
    b.calls.length = 0;
    const tick = async (ms: number) => {
      b.clock.now += ms;
      await b.wb.pollPrs();
    };
    await tick(5_000);
    expect(b.calls).toEqual([]);
    await tick(10_000);
    expect(b.calls).toEqual(['view klaud/run']);
    b.calls.length = 0;
    for (let i = 0; i < 9; i++) await tick(5_000); // 60s since the first look
    expect(b.calls.filter((c) => c === 'view klaud/run')).toHaveLength(3);
    expect(b.calls.filter((c) => c === 'view klaud/idle')).toHaveLength(1);
    expect(b.calls).not.toContain('view klaud/done');
  });

  it('looks right away after a push, then every 15s for a while', async () => {
    const b = bench([{ id: 'a', branch: 'klaud/a' }]);
    b.remote['klaud/a'] = 'aaa';
    await b.wb.refreshPrs();
    b.calls.length = 0;
    b.clock.now += 5_000;
    await b.wb.pollPrs();
    expect(b.calls).toEqual([]);
    b.remote['klaud/a'] = 'bbb'; // pushed
    b.gh.set('klaud/a', pr(9, { checks: 'pending' }));
    b.clock.now += 5_000;
    await b.wb.pollPrs();
    expect(b.calls).toEqual(['view klaud/a']);
    expect(b.prs().a?.number).toBe(9);
    // A client that pushed can say so too.
    b.calls.length = 0;
    b.clock.now += 1_000;
    await b.wb.pollPrs('push', 'a');
    expect(b.calls).toEqual(['view klaud/a']);
  });

  it('refreshes on focus what was not looked at in the last few seconds, but not merged PRs', async () => {
    const b = bench([
      { id: 'a', branch: 'klaud/a', project: 'x' },
      { id: 'm', branch: 'klaud/m', project: 'y' },
    ]);
    b.gh.set('klaud/a', pr(1));
    b.gh.set('klaud/m', pr(2, { state: 'MERGED' }));
    await b.wb.refreshPrs();
    b.calls.length = 0;
    b.clock.now += 2_000;
    await b.wb.pollPrs('focus');
    expect(b.calls).toEqual([]);
    b.clock.now += 10_000;
    b.gh.set('klaud/a', pr(1, { state: 'MERGED' }));
    await b.wb.pollPrs('focus');
    expect(b.calls).toEqual(['view klaud/a']);
    expect(b.prs().a?.state).toBe('MERGED');
  });

  it('runs a focus refresh asked for while a tick runs right after it, never drops it', async () => {
    const b = bench([
      { id: 'run', branch: 'klaud/run', project: 'x' },
      { id: 'idle', branch: 'klaud/idle', project: 'y' },
    ]);
    b.gh.set('klaud/run', pr(1, { checks: 'pending' }));
    b.gh.set('klaud/idle', pr(2));
    await b.wb.refreshPrs();
    b.calls.length = 0;
    b.clock.now += 15_000;
    const tick = b.wb.pollPrs(); // looks at the pending one; gh is slow
    b.gh.set('klaud/idle', pr(2, { state: 'MERGED' }));
    await b.wb.pollPrs('focus'); // arrives mid-tick: queued, not dropped
    expect(b.calls).toEqual(['view klaud/run']);
    await tick;
    expect(b.calls).toEqual(['view klaud/run', 'view klaud/idle']);
    expect(b.prs().idle?.state).toBe('MERGED');
  });

  it('runs a focus refresh asked for before the first look once that look is done', async () => {
    const b = bench([{ id: 'a', branch: 'klaud/a' }]);
    b.gh.set('klaud/a', pr(1));
    const first = b.wb.refreshPrs();
    await b.wb.pollPrs('focus');
    await first;
    // Just looked at, so the queued focus finds nothing stale, but it did run (and didn't throw).
    expect(b.calls).toEqual(['view klaud/a']);
    b.clock.now += 10_000;
    const tick = b.wb.pollPrs('push', 'a');
    await b.wb.pollPrs('push', 'a'); // the same push twice while it runs: one more look, not two
    await tick;
    expect(b.calls).toEqual(['view klaud/a', 'view klaud/a', 'view klaud/a']);
  });

  it('says merged or closed once, even if gh flickers', async () => {
    const b = bench([{ id: 'a', branch: 'klaud/a' }]);
    b.gh.set('klaud/a', pr(1));
    await b.wb.refreshPrs();
    b.gh.set('klaud/a', pr(1, { state: 'CLOSED' }));
    await b.wb.refreshPrs('a');
    b.gh.set('klaud/a', pr(1));
    await b.wb.refreshPrs('a');
    b.gh.set('klaud/a', pr(1, { state: 'CLOSED' }));
    await b.wb.refreshPrs('a');
    expect(b.notices.map((n) => n.title)).toEqual(['PR #1 was closed without merging']);
  });

  it("doesn't touch the store when nothing changed", async () => {
    const b = bench([{ id: 'a', branch: 'klaud/a' }]);
    b.gh.set('klaud/a', pr(1));
    await b.wb.refreshPrs();
    const before = b.store.getState().prs;
    await b.wb.refreshPrs('a');
    expect(b.store.getState().prs).toBe(before);
  });
});
