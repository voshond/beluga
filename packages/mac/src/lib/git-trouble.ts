import type { GitTrouble } from '../../../../src/shared/git-trouble.js';
import { openSheet } from './sheets.js';

/** What to do again once a fix worked: Create PR (as a draft), or nothing (Merge, Update Branch: you press it again). */
export type GitRetry = 'pr' | 'pr_draft' | 'pr_original' | 'merge_base' | 'none';

/**
 * A GitHub step came back: when it couldn't reach GitHub (an SSH key, gh missing or logged out…),
 * show the card that says why in plain words, with its fixes (BLG-213). True when it did.
 */
export function showGitTrouble(wsId: string, out: { readonly ok: boolean; readonly trouble?: GitTrouble } | undefined, retry: GitRetry): boolean {
  if (!out?.trouble) return false;
  openSheet({ kind: 'git_trouble', wsId, trouble: out.trouble, retry });
  return true;
}
