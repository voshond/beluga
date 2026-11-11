import { describe, expect, it } from 'vitest';
import type { BranchStep } from '../src/core/branch-state.js';
import { isPrWay, withPrWayFirst } from '../packages/mac/src/lib/pr-way.js';

const step = (id: BranchStep['id']): BranchStep => ({ id, label: id, hint: '' });
const ids = (steps: readonly BranchStep[]): string[] => steps.map((s) => s.id);

describe('withPrWayFirst', () => {
  const steps = [step('pr'), step('pr_claude'), step('pr_custom'), step('pr_draft'), step('merge_base'), step('commit')];

  it('puts the way you picked last in Create PR’s place, Create PR into the menu', () => {
    expect(ids(withPrWayFirst(steps, 'pr_custom'))).toEqual(['pr_custom', 'pr', 'pr_claude', 'pr_draft', 'merge_base', 'commit']);
  });

  it('keeps the order for plain Create PR, or a way this branch doesn’t offer', () => {
    expect(withPrWayFirst(steps, 'pr')).toBe(steps);
    expect(withPrWayFirst(steps, 'pr_original')).toBe(steps);
  });

  it('only swaps when Create PR leads (an open PR’s Merge stays first)', () => {
    const merging = [step('merge_pr'), step('open_pr'), step('pr_claude')];
    expect(withPrWayFirst(merging, 'pr_claude')).toBe(merging);
  });

  it('knows the ways', () => {
    expect(isPrWay('pr_draft')).toBe(true);
    expect(isPrWay('merge_base')).toBe(false);
  });
});
