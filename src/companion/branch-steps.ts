import type { Session } from '../core/session.js';
import { worktreeOf } from './merge.js';
import type { PhoneBranchStep } from './protocol.js';

/**
 * A worktree's branch steps from the phone (1.8): the very steps the Mac's toolbar offers
 * (core/branch-state.ts), done the Mac's own way. One-click ones (archive, merge the PR, update
 * it) say how they went; the ones Claude does start in the worktree's conversation, where the
 * phone follows them. Merging into the main folder keeps its own sheet (companion.mergeCheck /
 * merge), and opening the PR is the phone's browser: neither comes here.
 */

export interface BranchStepResult {
  readonly ok: boolean;
  /** What happened, in a line the phone shows. */
  readonly message: string;
}

export async function branchStep(s: Session, topic: string, step: PhoneBranchStep): Promise<BranchStepResult> {
  const id = worktreeOf(s, topic);
  const ws = s.workspaces!;
  const bench = s.workbench;
  const name = ws.manager.find(id)?.name ?? 'The worktree';
  const claude = (what: string): BranchStepResult => ({ ok: true, message: `Your agent is ${what} in this conversation` });
  const needBench = (): NonNullable<typeof bench> => {
    if (!bench) throw new Error('Pull requests aren’t ready on your Mac yet');
    return bench;
  };
  switch (step) {
    case 'merge_pr':
    case 'merge_auto':
    case 'merge_admin': {
      const r = await needBench().mergePr(id, { method: 'squash', ...(step === 'merge_auto' ? { auto: true } : step === 'merge_admin' ? { admin: true } : {}) });
      return { ok: r.ok, message: r.message };
    }
    case 'cancel_auto':
      return needBench().cancelMergeWhenReady(id);
    case 'update_branch':
    case 'mark_ready': {
      // Trouble reaching GitHub comes as its plain sentence; the card with its fixes is on the Mac.
      const r = await needBench().prStep(id, step === 'mark_ready' ? 'ready' : 'update_branch');
      return { ok: r.ok, message: r.message };
    }
    case 'push':
    case 'rerun_checks': {
      const r = await (step === 'push' ? needBench().pushPr(id) : needBench().rerunChecks(id));
      return { ok: r.ok, message: r.message };
    }
    case 'resolve_pr':
      needBench().resolvePrConflicts(id);
      return claude('resolving the conflicts');
    case 'fix_checks':
      needBench().fixChecks(id);
      return claude('fixing the checks');
    case 'merge_claude':
      ws.askClaudeToMerge(id, s.store.getState().conflicts[id] ?? []);
      return claude('finishing the merge');
    case 'review_claude':
      ws.askClaudeToReview(id);
      return claude('reviewing the branch');
    case 'commit':
      await ws.commit(id);
      return { ok: true, message: 'Committed' };
    case 'pr':
    case 'pr_draft': {
      const r = await needBench().quickPr(id, step === 'pr_draft' ? { draft: true } : {});
      return { ok: r.ok, message: r.message };
    }
    case 'pr_original': {
      const r = await needBench().quickPr(id, { original: true });
      return { ok: r.ok, message: r.message };
    }
    case 'pr_claude':
      needBench().createPr(id);
      return claude('opening the pull request');
    case 'continue_after_merge':
      await needBench().continueAfterMerge(id);
      return { ok: true, message: 'This branch starts again from the latest base: the next change gets a new PR' };
    case 'archive': {
      const done = await ws.archive(id);
      return done ? { ok: true, message: `${name} is archived: its branch and conversation are kept` } : { ok: false, message: `Couldn’t archive ${name}: see your Mac` };
    }
    case 'delete':
      await ws.remove(id);
      return { ok: true, message: `${name} is deleted` };
  }
}
