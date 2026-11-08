import { formatBytes } from '@beluga/shared/format.js';
import type { ThreadChildren } from '@beluga/shared/threads.js';
import { Alert } from '../../components/Alert.js';
import { useThreadsChoice } from '../../dialogs/native/ThreadsChoice.js';
import type { WorktreeRow } from './worktrees-model.js';

/**
 * Before archiving, removing build files from or deleting several worktrees at once: what
 * happens to them, and what it frees or loses. Archiving keeps everything of yours; removing
 * build files keeps the worktrees and clears only what's made again; deleting (live or archived
 * ones) is for good.
 */

export type Batch = 'archive' | 'free' | 'delete';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function BatchAlert({ batch, rows, rebuildable, onConfirm, onCancel }: { batch: Batch; rows: readonly WorktreeRow[]; rebuildable: number; onConfirm: (children?: ThreadChildren) => void; onCancel: () => void }) {
  const n = rows.length;
  const threads = useThreadsChoice(rows.map((r) => r.ws.id), batch === 'delete' ? 'delete' : 'archive');
  const go = (): void => onConfirm(threads.children);
  const freed = rebuildable ? `about ${formatBytes(rebuildable)}` : 'their space';
  const outside = rows.filter((r) => r.madeBy.kind === 'outside').length;
  if (batch === 'free') {
    return (
      <Alert
        icon="archive"
        tone="info"
        title={`Remove build files from ${plural(n, 'worktree')}?`}
        message={
          <>
            <p>Deletes what the project makes again by itself: node_modules, build output and caches ({freed}).</p>
            <p>Your work stays: files, commits, uncommitted changes, ignored files like .env, and the worktrees themselves. To work in one again, run its setup (npm install and the like).</p>
          </>
        }
        confirm={{ label: 'Remove Build Files', onClick: () => onConfirm() }}
        onCancel={onCancel}
      />
    );
  }
  if (batch === 'delete' && !rows.some((r) => r.archived)) {
    // Beluga's own go with everything in them; another tool's (or a sub-agent's) only if git lets them, branch kept.
    const own = rows.filter((r) => r.madeBy.kind === 'beluga');
    const files = own.reduce((k, r) => k + (r.left?.files ?? 0), 0);
    const commits = own.filter((r) => r.ws.branch).reduce((k, r) => k + (r.left?.commits ?? 0), 0);
    const branches = own.filter((r) => r.ws.branch).length;
    const theirs = n - own.length;
    return (
      <Alert
        icon="alert"
        tone="danger"
        title={`Delete ${plural(n, 'worktree')} permanently?`}
        message={
          <>
            <p>
              {n === 1 ? 'Its folder goes, with its conversation' : 'Their folders go, with their conversations'}
              {branches ? ` and ${branches === 1 ? 'the branch' : `the ${branches} branches`} Beluga made${commits ? ` (${plural(commits, 'commit')} not in main)` : ''}` : ''}.
              {files ? ` ${plural(files, 'uncommitted file')} ${files === 1 ? 'is' : 'are'} lost.` : ''}
            </p>
            {theirs ? <p>{n === 1 ? 'It was' : theirs === 1 ? 'One was' : `${theirs} were`} made outside Beluga or by a sub-agent: {theirs === 1 ? 'its branch is' : 'their branches are'} kept, and git won’t delete one with uncommitted changes.</p> : null}
            <p>You can’t undo this. To keep the work, archive {n === 1 ? 'it' : 'them'} instead.</p>
          </>
        }
        confirm={{ label: `Delete ${plural(n, 'Worktree')}`, destructive: true, onClick: go }}
        onCancel={onCancel}
      >
        {threads.box}
      </Alert>
    );
  }
  if (batch === 'delete') {
    const branches = rows.filter((r) => r.madeBy.kind === 'beluga' && r.ws.branch).length;
    const saved = rows.filter((r) => r.ws.archive).length;
    return (
      <Alert
        icon="alert"
        tone="danger"
        title={`Delete ${plural(n, 'archived worktree')} permanently?`}
        message={
          <>
            <p>
              {saved ? `${saved === n ? 'Their archives' : plural(saved, 'archive')} (uncommitted work and files of yours kept when archived) ` : ''}
              {saved && branches ? 'and ' : ''}
              {branches ? `${branches === 1 ? 'the branch' : `${branches} branches`} Beluga made (commits only there) ` : ''}
              {saved || branches ? 'go, with their conversations.' : 'Their conversations go.'} Branches other tools made are kept.
            </p>
            <p>You can’t undo this.</p>
          </>
        }
        confirm={{ label: `Delete ${plural(n, 'Worktree')}`, destructive: true, onClick: go }}
        onCancel={onCancel}
      >
        {threads.box}
      </Alert>
    );
  }
  return (
    <Alert
      icon="archive"
      tone="info"
      title={`Archive ${plural(n, 'worktree')}?`}
      message={
        <>
          <p>Everything of yours in them is kept: uncommitted work, new files and ignored files like .env. Their build files are removed ({freed}), and the folders go.</p>
          <p>Their branches and conversations stay. Restore any of them from Archived on this page, as it was.</p>
          {outside ? <p>{outside === 1 ? 'One was' : `${outside} were`} made outside Beluga: the app that made {outside === 1 ? 'it' : 'them'} may still have {outside === 1 ? 'it' : 'them'} open.</p> : null}
        </>
      }
      confirm={{ label: `Archive ${plural(n, 'Worktree')}`, onClick: go }}
      onCancel={onCancel}
    >
      {threads.box}
    </Alert>
  );
}
