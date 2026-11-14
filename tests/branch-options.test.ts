import { describe, expect, it } from 'vitest';
import { THIS_COMPUTER } from '../src/shared/assistant.js';
import { branchOptions } from '../packages/mac/src/chat/branch-options.js';
import { filterEntries } from '../packages/mac/src/components/select-model.js';

const remotes = [
  { name: 'origin', label: 'voshond/beluga' },
  { name: 'upstream', label: 'kayraucklnc/beluga' },
];
const branches = ['origin/main', 'main', 'upstream/main', 'origin/feat/x', 'feat/x', 'upstream/plan/y'];

describe('branchOptions', () => {
  it('sections branches by their remote’s repository, origin first, then this Mac’s', () => {
    const entries = branchOptions(branches, 'origin/main', remotes);
    expect(entries).toEqual([
      {
        section: 'voshond/beluga',
        options: [
          { value: 'origin/main', label: 'main', short: 'origin/main', keywords: ['origin', 'voshond/beluga'], badge: 'default' },
          { value: 'origin/feat/x', label: 'feat/x', short: 'origin/feat/x', keywords: ['origin', 'voshond/beluga'] },
        ],
      },
      {
        section: 'kayraucklnc/beluga',
        options: [
          { value: 'upstream/main', label: 'main', short: 'upstream/main', keywords: ['upstream', 'kayraucklnc/beluga'] },
          { value: 'upstream/plan/y', label: 'plan/y', short: 'upstream/plan/y', keywords: ['upstream', 'kayraucklnc/beluga'] },
        ],
      },
      {
        section: `On ${THIS_COMPUTER}`,
        options: [
          { value: 'main', label: 'main' },
          { value: 'feat/x', label: 'feat/x' },
        ],
      },
    ]);
  });

  it('finds a remote branch by its full name', () => {
    const found = filterEntries(branchOptions(branches, 'origin/main', remotes), 'upstream main');
    expect(found).toEqual([{ section: 'kayraucklnc/beluga', options: [expect.objectContaining({ value: 'upstream/main' })] }]);
  });

  it('stays one flat list without remotes', () => {
    expect(branchOptions(['main', 'dev'], 'main')).toEqual([{ value: 'main', label: 'main', badge: 'default' }, { value: 'dev', label: 'dev' }]);
  });
});
