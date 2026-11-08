import { describe, expect, it } from 'vitest';
import { buildCommitAppend } from '../src/agent/prompt.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import type { AgentPlace, AgentRunInput, OpenPr } from '../src/agent/types.js';

/**
 * What a worktree's agent is told about committing and pushing (BLG-840): with an open pull request
 * it keeps it current, unless the owner said not to, and its last answer always says where the work is.
 */

const open = (more: Partial<OpenPr> = {}): OpenPr => ({ number: 398, url: 'https://github.com/o/r/pull/398', branch: 'beluga/inline-component-preview', push: true, ...more });

describe('buildCommitAppend', () => {
  it('no pull request: commit only, and say the work is committed here, not on a PR', () => {
    const text = buildCommitAppend();
    expect(text).toContain('commit them before you');
    expect(text).toContain('Never push, merge, rebase or open a pull request unless asked');
    expect(text).toContain('not on a pull request yet');
    expect(text).not.toContain('git push');
  });

  it('an open PR: push the branch to it at the end of a turn that committed, never forced', () => {
    const text = buildCommitAppend(open());
    expect(text).toContain("This branch's pull request is open: PR #398 (https://github.com/o/r/pull/398)");
    expect(text).toContain('`git push origin beluga/inline-component-preview`');
    expect(text).toContain('never --force');
    expect(text).toContain('A turn that\ncommitted nothing pushes nothing');
    expect(text).toContain('Never merge, rebase or open another pull request unless asked');
    expect(text).not.toContain('Never push,');
  });

  it('its last answer says where the work is: on PR #n, committed here, or merged', () => {
    const text = buildCommitAppend(open());
    expect(text).toContain('Your last answer ends by saying where the work is');
    expect(text).toContain('on PR #398 once pushed');
    expect(text).toContain('committed\nhere and not on PR #398 yet if the push failed');
    expect(text).toContain('Merged only if you merged it');
  });

  it('the owner’s setting off: never push, and say it isn’t on the PR yet', () => {
    const text = buildCommitAppend(open({ push: false }));
    expect(text).toContain('The owner pushes to it themselves');
    expect(text).toContain('never push, merge, rebase');
    expect(text).toContain('not on PR #398 yet');
    expect(text).not.toContain('git push');
  });

  it('someone’s fork PR checked out here: nothing to push to, and it says so', () => {
    const text = buildCommitAppend(open({ fork: true }));
    expect(text).toContain("from someone else's fork: you can't push to it");
    expect(text).toContain('not on PR #398');
    expect(text).not.toContain('git push');
  });
});

describe('runInstructions: a worktree run carries its open PR', () => {
  const input = (place: Partial<AgentPlace> = {}, more: Partial<AgentRunInput> = {}): AgentRunInput =>
    ({ prompt: 'hi', requesterName: 'kay', viaAgent: false, context: [], scope: 'full', env: { KLAUD_WORKTREE: '/wt' }, place: { cwd: '/wt', additionalDirectories: [], autoEdit: true, onSession: () => undefined, ...place }, ...more }) as unknown as AgentRunInput;

  it('pushes to the open PR in a worktree, and not without one', () => {
    expect(runInstructions(input({ openPr: open() }), 'kay')).toContain('git push origin beluga/inline-component-preview');
    expect(runInstructions(input(), 'kay')).toContain('not on a pull request yet');
    expect(runInstructions(input(), 'kay')).not.toContain('git push');
  });

  it('a plan’s task follows its brief instead', () => {
    expect(runInstructions(input({ openPr: open() }, { planBrief: '\nThe plan merges this.' }), 'kay')).not.toContain('git push');
  });
});
