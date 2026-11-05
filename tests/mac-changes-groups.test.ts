import { describe, expect, it } from 'vitest';
import { dirOf, groupByFolder, shownOrder } from '../packages/mac/src/lib/changes-model.js';

/** The Changes tab grouped by folder (BLG-739): one header per folder, its files under it. */

const f = (path: string, added = 0, removed = 0) => ({ path, added, removed });

describe('changes grouped by folder', () => {
  it('names a file’s folder, the top level as empty', () => {
    expect(dirOf('src/ui/App.tsx')).toBe('src/ui');
    expect(dirOf('README.md')).toBe('');
  });

  it('puts each file under its folder, top level first, then folders and names in order', () => {
    const files = [f('src/b.ts'), f('package.json'), f('docs/a.md'), f('src/a.ts'), f('src/ui/x.tsx')];
    const groups = groupByFolder(files);
    expect(groups.map((g) => g.dir)).toEqual(['', 'docs', 'src', 'src/ui']);
    expect(groups[2]!.files.map((x) => x.file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    // Each keeps its place in the review, which is what selecting it uses.
    expect(groups[2]!.files.map((x) => x.index)).toEqual([3, 0]);
  });

  it('adds up each folder’s lines', () => {
    const [g] = groupByFolder([f('src/a.ts', 3, 1), f('src/b.ts', 2, 5)]);
    expect(g).toMatchObject({ dir: 'src', added: 5, removed: 6 });
  });

  it('walks the files as shown, skipping folded folders', () => {
    const groups = groupByFolder([f('src/b.ts'), f('package.json'), f('docs/a.md'), f('src/a.ts')]);
    expect(shownOrder(groups, new Set())).toEqual([1, 2, 3, 0]);
    expect(shownOrder(groups, new Set(['docs']))).toEqual([1, 3, 0]);
  });

  it('has no groups for no files', () => {
    expect(groupByFolder([])).toEqual([]);
  });
});
