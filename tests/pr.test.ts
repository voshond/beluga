import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest } from '../src/core/work-store.js';
import {
  DEFAULT_PR_PROMPT,
  buildPrPrompt,
  checksState,
  customPrPrompt,
  describePr,
  ensurePrPromptFile,
  fixChecksPrompt,
  parsePr,
  prPromptFile,
  resetPrPrompt,
} from '../src/workspaces/pr.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({ impl: undefined as undefined | ((cmd: string, args: string[]) => { err?: Error; stdout?: string; stderr?: string }), calls: [] as Array<{ cmd: string; args: string[]; cwd?: string }> }));

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], opts: { cwd?: string }, cb: ExecCb) => {
    exec.calls.push({ cmd, args, cwd: opts.cwd });
    const r = exec.impl?.(cmd, args) ?? { err: new Error('not mocked') };
    queueMicrotask(() => cb(r.err ?? null, r.stdout ?? '', r.stderr ?? ''));
  },
}));

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', title: 't', draft: false, checks: 'none', ...over });

describe('buildPrPrompt', () => {
  const ctx = { branch: 'feat/x', base: 'origin/main', project: 'app' };

  it('fills every placeholder, stripping origin/ for baseBranch', () => {
    const out = buildPrPrompt(ctx, '{{branch}} {{base}} {{baseBranch}} {{project}} {{branch}}');
    expect(out).toBe('feat/x origin/main main app feat/x');
  });

  it('leaves a base without origin/ as is', () => {
    expect(buildPrPrompt({ ...ctx, base: 'develop' }, '{{base}}|{{baseBranch}}')).toBe('develop|develop');
  });

  it('fills the default template completely', () => {
    const out = buildPrPrompt(ctx, DEFAULT_PR_PROMPT);
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(out).toContain('gh pr create --base main --head feat/x');
    expect(out).toContain('git log origin/main..HEAD');
  });

  it('appends trimmed project guidelines and extra instructions', () => {
    const out = buildPrPrompt({ ...ctx, projectPrompt: '  Link the Linear ticket.  ', extra: '  mention the migration ' }, 'T');
    expect(out).toBe('T\n\nProject guidelines for pull requests (from the project\'s beluga.json):\nLink the Linear ticket.\n\nFor this pull request, also: mention the migration');
  });

  it('skips blank project prompt and extra', () => {
    expect(buildPrPrompt({ ...ctx, projectPrompt: '   ', extra: '\n' }, 'T')).toBe('T');
  });
});

describe('checksState', () => {
  it('is none for missing or empty checks', () => {
    expect(checksState(undefined)).toBe('none');
    expect(checksState([])).toBe('none');
  });

  it('is passing when everything succeeded or was skipped', () => {
    expect(checksState([{ conclusion: 'SUCCESS' }, { state: 'success' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }])).toBe('passing');
  });

  it.each(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])('%s is failing', (s) => {
    expect(checksState([{ conclusion: 'SUCCESS' }, { conclusion: s }])).toBe('failing');
  });

  it('failing wins over pending', () => {
    expect(checksState([{ status: 'IN_PROGRESS' }, { state: 'failure' }])).toBe('failing');
  });

  it.each(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])('%s is pending', (s) => {
    expect(checksState([{ conclusion: 'SUCCESS' }, { status: s }])).toBe('pending');
  });

  it('treats a check with no fields as pending', () => {
    expect(checksState([{}])).toBe('pending');
  });

  it('prefers conclusion over status', () => {
    expect(checksState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing');
  });
});

describe('parsePr', () => {
  it('returns undefined for bad JSON or missing fields', () => {
    expect(parsePr('not json')).toBeUndefined();
    expect(parsePr('null')).toBeUndefined();
    expect(parsePr(JSON.stringify({ url: 'u' }))).toBeUndefined();
    expect(parsePr(JSON.stringify({ number: '1', url: 'u' }))).toBeUndefined();
    expect(parsePr(JSON.stringify({ number: 1 }))).toBeUndefined();
  });

  it('parses a minimal open PR with defaults', () => {
    expect(parsePr(JSON.stringify({ number: 3, url: 'u' }))).toEqual({ number: 3, url: 'u', state: 'OPEN', title: '', draft: false, checks: 'none' });
  });

  it.each(['MERGED', 'CLOSED'] as const)('keeps %s state', (state) => {
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state }))?.state).toBe(state);
  });

  it('maps unknown states to OPEN', () => {
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', state: 'WEIRD' }))?.state).toBe('OPEN');
  });

  it('reads draft, title and checks', () => {
    const out = parsePr(JSON.stringify({ number: 1, url: 'u', title: 'Add x', isDraft: true, statusCheckRollup: [{ conclusion: 'FAILURE' }] }));
    expect(out).toMatchObject({ title: 'Add x', draft: true, checks: 'failing' });
  });

  it.each(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const)('keeps review decision %s', (review) => {
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', reviewDecision: review }))?.review).toBe(review);
  });

  it('drops empty or unknown review decisions', () => {
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', reviewDecision: '' }))).not.toHaveProperty('review');
    expect(parsePr(JSON.stringify({ number: 1, url: 'u', reviewDecision: 'MAYBE' }))).not.toHaveProperty('review');
  });
});

describe('describePr', () => {
  it('describes merged and closed PRs briefly', () => {
    expect(describePr(pr({ state: 'MERGED', checks: 'failing', draft: true }))).toBe('PR #12 merged');
    expect(describePr(pr({ state: 'CLOSED', review: 'APPROVED' }))).toBe('PR #12 closed');
  });

  it('describes an open PR', () => {
    expect(describePr(pr())).toBe('PR #12');
    expect(describePr(pr({ checks: 'passing' }))).toBe('PR #12 · checks passing');
    expect(describePr(pr({ draft: true, checks: 'pending', review: 'CHANGES_REQUESTED' }))).toBe('PR #12 (draft) · checks pending · changes requested');
    expect(describePr(pr({ review: 'APPROVED' }))).toBe('PR #12 · approved');
    expect(describePr(pr({ review: 'REVIEW_REQUIRED' }))).toBe('PR #12');
  });
});

describe('fixChecksPrompt', () => {
  it('names the PR number and url', () => {
    const out = fixChecksPrompt(pr({ number: 7, url: 'https://x/7' }));
    expect(out).toContain('pull request #7 (https://x/7)');
    expect(out).toContain('gh pr checks 7');
    expect(out).toContain('gh run view --log-failed');
  });
});

describe('custom PR prompt file', () => {
  let prev: string | undefined;
  let home: string;

  beforeEach(() => {
    prev = process.env.BELUGA_HOME;
    home = mkdtempSync(path.join(os.tmpdir(), 'klaud-pr-home-'));
    process.env.BELUGA_HOME = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.BELUGA_HOME;
    else process.env.BELUGA_HOME = prev;
  });

  it('lives under BELUGA_HOME/prompts, read at call time', () => {
    expect(prPromptFile()).toBe(path.join(home, 'prompts', 'pull-request.md'));
  });

  it('is undefined when the file is missing', () => {
    expect(customPrPrompt()).toBeUndefined();
  });

  it('ensurePrPromptFile writes the default and is then not "custom"', () => {
    const file = ensurePrPromptFile();
    expect(file).toBe(prPromptFile());
    expect(readFileSync(file, 'utf8')).toBe(`${DEFAULT_PR_PROMPT}\n`);
    expect(customPrPrompt()).toBeUndefined();
  });

  it('ensurePrPromptFile does not overwrite an edited file', () => {
    mkdirSync(path.dirname(prPromptFile()), { recursive: true });
    writeFileSync(prPromptFile(), 'Mine {{branch}}\n');
    ensurePrPromptFile();
    expect(readFileSync(prPromptFile(), 'utf8')).toBe('Mine {{branch}}\n');
    expect(customPrPrompt()).toBe('Mine {{branch}}');
  });

  it('treats a blank file as not customized', () => {
    mkdirSync(path.dirname(prPromptFile()), { recursive: true });
    writeFileSync(prPromptFile(), '  \n');
    expect(customPrPrompt()).toBeUndefined();
  });

  it('buildPrPrompt uses the custom prompt by default', () => {
    expect(buildPrPrompt({ branch: 'b', base: 'origin/main', project: 'p' })).toContain('gh pr create --base main --head b');
    mkdirSync(path.dirname(prPromptFile()), { recursive: true });
    writeFileSync(prPromptFile(), 'Custom for {{project}} on {{branch}}');
    expect(buildPrPrompt({ branch: 'b', base: 'origin/main', project: 'p' })).toBe('Custom for p on b');
  });

  it('resetPrPrompt removes the file and tolerates a missing one', () => {
    const file = ensurePrPromptFile();
    resetPrPrompt();
    expect(existsSync(file)).toBe(false);
    expect(() => resetPrPrompt()).not.toThrow();
  });

  it('accepts an explicit file path', () => {
    const file = path.join(home, 'elsewhere', 'p.md');
    ensurePrPromptFile(file);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, 'X');
    expect(customPrPrompt(file)).toBe('X');
    resetPrPrompt(file);
    expect(existsSync(file)).toBe(false);
  });
});

describe('hasGh / findPr (gh mocked)', () => {
  const load = async () => {
    vi.resetModules();
    return import('../src/workspaces/pr.js');
  };

  beforeEach(() => {
    exec.calls.length = 0;
    exec.impl = undefined;
  });

  it('hasGh is false when gh auth fails, and is checked once', async () => {
    exec.impl = () => ({ err: new Error('x'), stderr: 'not logged in' });
    const m = await load();
    expect(await m.hasGh()).toBe(false);
    expect(await m.hasGh()).toBe(false);
    expect(exec.calls).toEqual([{ cmd: 'gh', args: ['auth', 'status'], cwd: process.cwd() }]);
  });

  it('findPr returns undefined without gh', async () => {
    exec.impl = () => ({ err: new Error('no gh') });
    const m = await load();
    expect(await m.findPr('/repo', 'feat/x')).toBeUndefined();
    expect(exec.calls.some((c) => c.args[0] === 'pr')).toBe(false);
  });

  it('findPr parses gh pr view output', async () => {
    exec.impl = (_cmd, args) => (args[0] === 'auth' ? { stdout: 'ok' } : { stdout: JSON.stringify({ number: 5, url: 'u', state: 'OPEN', title: 'T', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }], reviewDecision: 'APPROVED' }) });
    const m = await load();
    expect(await m.findPr('/repo', 'feat/x')).toEqual({ number: 5, url: 'u', state: 'OPEN', title: 'T', draft: false, checks: 'passing', checkRuns: [{ name: 'check', state: 'completed', conclusion: 'success' }], review: 'APPROVED' });
    const view = exec.calls.find((c) => c.args[0] === 'pr');
    expect(view).toEqual({ cmd: 'gh', args: ['pr', 'view', 'feat/x', '--json', 'number,url,state,title,isDraft,statusCheckRollup,reviewDecision,mergeable,mergeStateStatus,autoMergeRequest,headRefOid'], cwd: '/repo' });
  });

  it('findPr returns undefined when there is no PR for the branch', async () => {
    exec.impl = (_cmd, args) => (args[0] === 'auth' ? { stdout: 'ok' } : { err: new Error('exit 1'), stderr: 'no pull requests found' });
    const m = await load();
    expect(await m.findPr('/repo', 'nope')).toBeUndefined();
  });

  it('findPr returns undefined for unparseable output', async () => {
    exec.impl = (_cmd, args) => (args[0] === 'auth' ? { stdout: 'ok' } : { stdout: 'garbage' });
    const m = await load();
    expect(await m.findPr('/repo', 'b')).toBeUndefined();
  });
});
