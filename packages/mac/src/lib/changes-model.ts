/** The Changes tab's list grouped by folder (BLG-739). Pure, so it's tested without a screen. */

export interface ChangedLike {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

/** A folder's changed files, each with its place in the review (what selecting it uses). */
export interface FolderGroup<F extends ChangedLike> {
  readonly dir: string;
  readonly files: readonly { readonly file: F; readonly index: number }[];
  readonly added: number;
  readonly removed: number;
}

/** The folder a path is in ('' at the top level). */
export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** One group per folder: the top level first, then folders by name, and their files by name. */
export function groupByFolder<F extends ChangedLike>(files: readonly F[]): FolderGroup<F>[] {
  const dirs = new Map<string, { file: F; index: number }[]>();
  files.forEach((file, index) => {
    const dir = dirOf(file.path);
    dirs.set(dir, [...(dirs.get(dir) ?? []), { file, index }]);
  });
  return [...dirs.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : byName(a, b)))
    .map(([dir, list]) => ({
      dir,
      files: [...list].sort((a, b) => byName(a.file.path, b.file.path)),
      added: list.reduce((n, x) => n + x.file.added, 0),
      removed: list.reduce((n, x) => n + x.file.removed, 0),
    }));
}

/** The files' places in the review, in the order they're shown (a folded folder's are hidden). */
export function shownOrder<F extends ChangedLike>(groups: readonly FolderGroup<F>[], folded: ReadonlySet<string>): number[] {
  return groups.flatMap((g) => (folded.has(g.dir) ? [] : g.files.map((x) => x.index)));
}
