import { THIS_COMPUTER } from '../../../../src/shared/assistant.js';
import type { BranchRemote } from '../../../../src/workspaces/types.js';
import type { SelectEntry, SelectOption } from '../components/select-parts.js';

/**
 * The branches a worktree can start from, for the Based on pop-up: one section per remote, named
 * for its repository (origin's first), then this computer's own branches. The default one says so.
 */
export function branchOptions(branches: readonly string[], base: string | undefined, remotes: readonly BranchRemote[] = []): Array<SelectEntry<string>> {
  const option = (b: string, remote?: BranchRemote): SelectOption<string> => ({
    value: b,
    label: remote ? b.slice(remote.name.length + 1) : b,
    ...(remote ? { short: b, keywords: [remote.name, remote.label] } : {}),
    ...(b === base ? { badge: 'default' } : {}),
  });
  if (!remotes.length) return branches.map((b) => option(b));
  const remoteOf = (b: string): BranchRemote | undefined => remotes.find((r) => b.startsWith(`${r.name}/`));
  const sections = remotes.map((r) => ({ section: r.label, options: branches.filter((b) => remoteOf(b) === r).map((b) => option(b, r)) }));
  return [...sections, { section: `On ${THIS_COMPUTER}`, options: branches.filter((b) => !remoteOf(b)).map((b) => option(b)) }];
}
