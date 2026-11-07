import { type ReactNode, createContext, useContext, useMemo, useState } from 'react';
import { boardName, boardOf, isOwnBoard, isVisiting, reposOf } from '@beluga/core/board/model.js';
import { Field, FormSheet, TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, cx } from '../components/ui.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { PickMenu } from './PickMenu.js';
import { useBoard, useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

/**
 * Boards and repos, many to many: a board's mark (its repos' icons, a few stacked), the repo chip a
 * task on a board of several repos wears, the repo picker on a task, and the sheet that makes a
 * board or changes the repos it covers.
 */

/** The repos' icons, overlapping a little (up to three). */
export function RepoStack({ repos, names, size = 16 }: { repos: readonly string[]; names: (id: string) => string | undefined; size?: number }) {
  const shown = repos.slice(0, 3);
  return (
    <span className={t.repoStack} style={{ ['--repo-size' as string]: `${size}px` }}>
      {shown.map((r) => (
        <span key={r} className={t.repoStackItem}>
          <ProjectIcon id={r} name={names(r) ?? r} size={size} round />
        </span>
      ))}
    </span>
  );
}

/** Two repos' icons, one tucked behind the other, inside one icon's square (a menu's mark slot). */
function RepoPair({ repos, names, size }: { repos: readonly string[]; names: (id: string) => string | undefined; size: number }) {
  const inner = Math.round(size * 0.72);
  return (
    <span className={t.repoPair} style={{ width: size, height: size }}>
      {repos.slice(0, 2).map((r, i) => (
        <span key={r} className={cx(t.repoPairItem, i === 1 && t.repoPairFront)}>
          <ProjectIcon id={r} name={names(r) ?? r} size={inner} />
        </span>
      ))}
    </span>
  );
}

/**
 * A board: its repo's icon, or its repos' stacked when it covers several. `fit` keeps a board of
 * several in one icon's square (two icons tucked together), so a menu's names stay lined up.
 */
export function BoardMark({ repos, names, size = 16, fit }: { repos: readonly string[]; names: (id: string) => string | undefined; size?: number; fit?: boolean }) {
  if (repos.length < 2) return repos[0] ? <ProjectIcon id={repos[0]} name={names(repos[0]) ?? repos[0]} size={size} /> : <Icon name="columns" size={size - 2} />;
  return fit ? <RepoPair repos={repos} names={names} size={size} /> : <RepoStack repos={repos} names={names} size={size - 2} />;
}

/** Whether a task's board covers several repos (then its cards say which one it runs in). */
export function useSeveralRepos(issue: { readonly board?: string; readonly projectId: string }): boolean {
  return useApp((s) => {
    const repos = reposOf(s.board, boardOf(issue));
    return repos.length > 1 || !repos.includes(issue.projectId);
  });
}

/** The repo a task runs in, on a card or a row of a board that covers several (its name too: an icon alone is easy to miss). */
export function RepoChip({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const name = useApp((s) => s.projects.find((p) => p.id === projectId)?.name) ?? 'Repo';
  return (
    <span className={cx(t.repoChip, compact && t.repoChipCompact)} title={`Runs in ${name}`}>
      <ProjectIcon id={projectId} name={name} size={12} />
      <span className={t.repoChipName}>{name}</span>
    </span>
  );
}

/** The board Tasks is showing, for the cards and rows on it (none: a task shown anywhere else). */
const ShowingBoard = createContext<string | undefined>(undefined);
export const ShowingBoardProvider = ShowingBoard.Provider;

/**
 * The board a task is on, when the board shown isn't it: a repo's own board shows what runs in its
 * repo from other boards (BLG-559), a shade back and saying where it lives.
 */
export function useVisitingFrom(issue: { readonly board?: string; readonly projectId: string }): string | undefined {
  const showing = useContext(ShowingBoard);
  return showing && isVisiting(issue, showing) ? boardOf(issue) : undefined;
}

/** On a card or row a repo's board shows from another board: that board's mark and name; a click opens it. */
export function OnBoardChip({ boardId, compact }: { boardId: string; compact?: boolean }) {
  const board = useBoard();
  const projects = useApp((s) => s.projects);
  const { openList } = useTaskActions();
  const names = (id: string): string | undefined => projects.find((p) => p.id === id)?.name;
  const name = boardName(board, boardId, names);
  const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();
  return (
    <button
      type="button"
      className={cx(t.repoChip, t.onBoardChip, compact && t.repoChipCompact)}
      title={`On the ${name} board: open it`}
      aria-label={`On the ${name} board`}
      onPointerDown={stop}
      onClick={(e) => (stop(e), openList(boardId))}
    >
      <BoardMark repos={reposOf(board, boardId)} names={names} size={12} fit />
      <span className={t.repoChipName}>{name}</span>
    </button>
  );
}

/** The repo a task runs in, on its page: the board's repos to move it to (it keeps its board and key). */
export function RepoPicker({ issue, children }: { issue: { readonly id: string; readonly board?: string; readonly projectId: string }; children: ReactNode }) {
  const board = useBoard();
  const projects = useApp((s) => s.projects);
  const { api, act } = useTaskActions();
  const repos = [...new Set([...reposOf(board, boardOf(issue)), issue.projectId])].filter((r) => projects.some((p) => p.id === r && p.root));
  const name = (id: string): string => projects.find((p) => p.id === id)?.name ?? id;
  return (
    <PickMenu<string>
      label="Repo"
      choices={repos.map((r) => ({ value: r, label: name(r), mark: <ProjectIcon id={r} name={name(r)} size={16} /> }))}
      chosen={[issue.projectId]}
      onPick={(r) => void act(() => api.update(issue.id, { projectId: r }), `It runs in ${name(r)} now`)}
      actions={[{ label: 'Repos on This Board…', icon: 'gear', onSelect: () => openSheet({ kind: 'task_board', boardId: boardOf(issue) }) }]}
      align="end"
    >
      {children}
    </PickMenu>
  );
}

/**
 * Delete a board you made, after asking: it's a view over a few repos, so its tasks go home to the
 * board of the repo each runs in, keys kept.
 */
export function useDeleteBoard(): (boardId: string) => void {
  const board = useBoard();
  const { api, act, openList } = useTaskActions();
  return (boardId) => {
    const name = board.projects[boardId]?.name ?? 'this';
    const tasks = board.issues.filter((i) => boardOf(i) === boardId).length;
    openSheet({
      kind: 'confirm',
      title: `Delete the ${name} board?`,
      message: tasks
        ? `Its ${tasks === 1 ? 'task goes' : `${tasks} tasks go`} back to the board of the repo ${tasks === 1 ? 'it runs' : 'each runs'} in, keys kept. The repos aren’t touched.`
        : 'Nothing is on it. The repos it covered keep their own boards.',
      confirm: 'Delete Board',
      destructive: true,
      run: () =>
        void act(() => api.removeBoard(boardId), tasks ? `The board is gone: ${tasks === 1 ? 'its task is' : `its ${tasks} tasks are`} back on their repos’ boards` : 'The board is gone').then((moved) => {
          if (moved !== undefined) openList();
        }),
    });
  };
}

/**
 * New Board (no `boardId`), or a board's settings: its name and the repos it covers. A repo's own
 * board always covers its repo; a board of its own covers the ones you tick, and can be deleted
 * (its tasks go home to their repos' boards). Tasks stay where they are whatever else changes here.
 */
export function BoardSheet({ boardId, repos: startRepos, close }: { boardId?: string; repos?: readonly string[]; close: () => void }) {
  const board = useBoard();
  const allProjects = useApp((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const { client } = useBeluga();
  const { api, openList } = useTaskActions();
  const deleteBoard = useDeleteBoard();
  const editing = boardId !== undefined;
  const own = !editing || isOwnBoard(boardId);
  const saved = editing ? board.projects[boardId] : undefined;
  const repoName = editing && !own ? projects.find((p) => p.id === boardId)?.name : undefined;
  const [name, setName] = useState(saved?.name ?? '');
  const [repos, setRepos] = useState<readonly string[]>(() => (editing ? reposOf(board, boardId).filter((r) => r !== boardId) : (startRepos ?? []).filter((r) => projects.some((p) => p.id === r))));
  const [prefix, setPrefix] = useState('');
  const toggle = (id: string): void => setRepos((now) => (now.includes(id) ? now.filter((r) => r !== id) : [...now, id]));
  const count = repos.length + (own ? 0 : 1);
  const canSubmit = (own ? Boolean(name.trim()) && repos.length > 0 : true) && (!prefix || /^[A-Za-z0-9]{2,6}$/.test(prefix));
  return (
    <FormSheet
      title={editing ? `${saved?.name ?? repoName ?? 'Board'} Board` : 'New Board'}
      icon="columns"
      intro={
        editing
          ? `Tasks here run in any of the repos it covers, each in the one it’s for. Keys start with ${saved?.prefix ?? '…'}-.`
          : 'One board for work across a few repos: each task on it runs in one of them, and Start makes its worktree there.'
      }
      submitLabel={editing ? 'Save' : 'Create Board'}
      canSubmit={canSubmit}
      width={520}
      onCancel={close}
      footer={
        editing && own ? (
          <Button variant="quiet" size="small" onClick={() => deleteBoard(boardId)}>
            Delete Board…
          </Button>
        ) : null
      }
      onSubmit={async () => {
        if (!editing) {
          const id = await api.createBoard({ name: name.trim(), repos: [...repos], ...(prefix ? { prefix } : {}) });
          close();
          openList(id);
          toast(client, `${name.trim()} is ready: new tasks there run in the repo you pick`, 'success');
          return;
        }
        await api.editBoard(boardId, { name: name.trim(), repos: [...repos] });
        close();
        toast(client, count > 1 ? `The board covers ${count} repos` : 'Saved', 'success');
      }}
    >
      <Field label="Name" htmlFor="board-name" {...(own ? {} : { hint: `Empty: ${repoName ?? 'the project'}’s name` })}>
        <TextInput id="board-name" value={name} onChange={setName} maxLength={60} placeholder={own ? 'Launch' : repoName} data-autofocus />
      </Field>
      <Field label="Repos" hint={own ? 'Tick the repos its tasks run in.' : 'Other repos whose tasks go on this board too.'}>
        <div className={t.repoList} role="group" aria-label="Repos">
          {projects.map((p) => {
            const self = p.id === boardId && !own;
            const on = self || repos.includes(p.id);
            return (
              <button key={p.id} type="button" role="checkbox" aria-checked={on} disabled={self} className={cx(t.repoRow, on && t.repoRowOn)} onClick={() => toggle(p.id)}>
                <ProjectIcon id={p.id} name={p.name} size={18} />
                <span className={t.repoRowName}>{p.name}</span>
                {self ? <span className={t.repoRowNote}>Its own</span> : <Icon name={on ? 'check' : 'plus'} size={12} />}
              </button>
            );
          })}
        </div>
      </Field>
      {editing ? null : (
        <Field label="Keys" htmlFor="board-prefix" hint="What its task keys start with. Empty: made from the name.">
          <TextInput id="board-prefix" value={prefix} onChange={(v) => setPrefix(v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} mono placeholder="LNCH" />
        </Field>
      )}
    </FormSheet>
  );
}
