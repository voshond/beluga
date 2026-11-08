import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core/store.js';
import type { PrCheck, PullRequest } from '../src/core/work-store.js';
import { initialAppState, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import type { BranchState } from '../src/core/branch-state.js';

/**
 * The toolbar's main button when the branch has no steps of its own: never a stale or bare
 * "Resolve" (BLG-753). It reads the PR's blocker the way the branch control does.
 */

/** The Mac's toolbar model, through a variable: the root typecheck can't follow the Mac app's @beluga paths (its own tsc checks the file). */
const MODULE = '../packages/mac/src/layout/toolbar-actions.js';
interface ToolAction { readonly id: string; readonly label: string; readonly hint: string; readonly icon: string; readonly action: string; readonly tone?: string }
interface Toolbar {
  pickPrimary: (state: AppState, ws: Workspace, all: readonly ToolAction[]) => ToolAction | undefined;
  shortOf: (a: ToolAction) => string;
  toolbarActions: (state: AppState, ws: Workspace) => { readonly primary?: ToolAction; readonly branch?: BranchState };
}
const { pickPrimary, shortOf, toolbarActions } = (await import(MODULE)) as Toolbar;

const ws = (over: Partial<Workspace> = {}): Workspace => ({ id: 'w1', projectRoot: '/p', projectId: 'p1', name: 'fix-ci', path: '/wt/w1', kind: 'worktree', createdAt: 1, branch: 'beluga/fix-ci', base: 'origin/main', external: false, status: { changed: 0, ahead: 2, behind: 0 }, ...over });
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({ number: 366, url: 'https://github.com/o/r/pull/366', state: 'OPEN', title: 't', draft: false, checks: 'passing', ...over });
const stateWith = (w: Workspace, p?: PullRequest): AppState => {
  const project: Project = { id: 'p1', name: 'api', root: '/p', base: 'origin/main', workspaces: [w] };
  const s = [{ type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [project] }, ...(p ? [{ type: 'pr', id: w.id, pr: p }] : [])].reduce<AppState>((st, a) => reduceApp(st, a as never), initialAppState('room'));
  return { ...s, gh: true };
};
/** What the shared buttons give it: Open PR (it has one), Commit when there's something to commit. */
const buttons = (pr = true): ToolAction[] => [
  { id: 'pr', label: pr ? 'Pull Request…' : 'Create PR', hint: '', icon: 'pr', action: 'pr' },
  { id: 'merge', label: 'Merge Locally…', hint: '', icon: 'merge', action: 'merge' },
];
const primary = (w: Workspace, p?: PullRequest) => pickPrimary(stateWith(w, p), w, buttons(Boolean(p)));
const failed = (name: string): PrCheck => ({ name, state: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/5/job/1' });
const running = (name: string): PrCheck => ({ name, state: 'in_progress' });

describe('pickPrimary: a PR’s next step', () => {
  it('conflicts: Resolve Conflicts…, and folded it still says what it resolves', () => {
    const a = primary(ws(), pr({ conflicts: true }))!;
    expect([a.action, a.label, a.tone]).toEqual(['resolve_pr', 'Resolve Conflicts…', 'error']);
    expect(shortOf(a)).toBe('Resolve Conflicts');
  });

  it('failed checks: Fix Checks…, folded "Fix Checks" (never a bare "Fix")', () => {
    const a = primary(ws(), pr({ checks: 'failing', checkRuns: [failed('test')] }))!;
    expect([a.action, a.label]).toEqual(['fix_checks', 'Fix Checks…']);
    expect(shortOf(a)).toBe('Fix Checks');
  });

  it('commits not pushed yet: GitHub’s conflicts and failed checks are old news, so no red Resolve or Fix', () => {
    const notPushed = ws({ status: { changed: 0, ahead: 3, behind: 0, unpushed: 1 } });
    const a = primary(notPushed, pr({ conflicts: true, checks: 'failing' }))!;
    expect(a.action).toBe('pr');
    // Never a bare "PR #366" while it lacks commits made here (BLG-840).
    expect(a.label).toBe('PR #366 · 1 Not Pushed');
    expect(a.hint).toBe('1 commit not on PR #366: push them before you merge it');
    expect(a.tone).toBe('info');
  });

  it('checks still running (one failed already): no red Fix yet', () => {
    const a = primary(ws(), pr({ checks: 'failing', checkRuns: [failed('test'), running('e2e')] }))!;
    expect([a.action, a.label, a.tone]).toEqual(['pr', 'PR #366', undefined]);
  });

  it('GitHub still working out mergeability shows no conflict', () => {
    // pr.ts sets `conflicts` only for CONFLICTING: an UNKNOWN PR comes without it.
    expect(primary(ws(), pr())?.action).toBe('pr');
  });

  it('BLG-840: commits its open PR doesn’t have lead as “Push 3 Commits to PR #398”, never a bare “PR #398”', () => {
    const behind = ws({ status: { changed: 0, ahead: 11, behind: 0, unpushed: 3 } });
    const t = toolbarActions(stateWith(behind, pr({ number: 398 })), behind);
    expect(t.primary).toBeUndefined();
    expect(t.branch?.label).toBe('3 commits not on PR');
    expect(t.branch?.pr?.number).toBe(398);
    expect(t.branch?.steps.map((s) => s.label)).toEqual(['Push 3 Commits to PR #398', 'Push and Merge When Ready', 'Open PR #398']);
    // No step merges it as it is.
    expect(t.branch?.steps.some((s) => s.id === 'merge_pr' || s.id === 'merge_admin')).toBe(false);
    // Pushed: the PR is ready to merge again.
    const pushed = ws({ status: { changed: 0, ahead: 11, behind: 0 } });
    expect(toolbarActions(stateWith(pushed, pr({ number: 398 })), pushed).branch?.steps[0]).toMatchObject({ id: 'merge_pr', label: 'Squash and Merge' });
  });

  it('in the toolbar, an open PR’s worktree leads with its branch steps, so the two never disagree', () => {
    const notPushed = ws({ status: { changed: 0, ahead: 3, behind: 0, unpushed: 1 } });
    const t = toolbarActions(stateWith(notPushed, pr({ conflicts: true })), notPushed);
    expect(t.primary).toBeUndefined();
    expect(t.branch?.kind).toBe('not_pushed');
    expect(t.branch?.steps[0]?.id).toBe('push');
  });
});
