import { Icon } from '../components/Icon.js';
import { Segmented } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import type { View } from '@beluga/core/store.js';
import { Row } from '../layout/sidebar-parts.js';
import { projectOfView } from '../tasks/use-tasks.js';
import w from './work.module.css';

/**
 * Work: Tasks, Issues and Actions behind one sidebar row (BLG-197), so the sidebar stays short.
 * The row opens the one you used last; a switch over each list moves between them. Plans have a row of their own.
 */

export type WorkPage = 'tasks' | 'issues' | 'actions';

const KEY = 'beluga.work.last';
const lastPage = (): WorkPage => {
  const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  return v === 'issues' || v === 'actions' ? v : 'tasks';
};
const remember = (p: WorkPage): void => {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    // Private storage: it just opens Tasks next time.
  }
};

/** Which of Work's pages a view belongs to (a task or an issue counts as its list). */
export function workPageOf(view: View): WorkPage | undefined {
  if (view.kind === 'tasks' || view.kind === 'task') return 'tasks';
  if (view.kind === 'issues' || view.kind === 'gh_issue') return 'issues';
  if (view.kind === 'actions' || view.kind === 'gh_run') return 'actions';
  return undefined;
}

function useOpenWork(): (page: WorkPage) => void {
  const actions = useActions();
  const here = useApp(projectOfView);
  return (page) => {
    remember(page);
    const at = page !== 'tasks' && here ? { projectId: here } : {};
    actions.run({ type: 'view', view: { kind: page, ...at } as View });
  };
}

export function WorkNav() {
  const open = useOpenWork();
  const board = useApp((s) => s.board.enabled);
  const page = useApp((s) => workPageOf(s.view));
  if (!board) return null;
  return <Row icon={<Icon name="task" size={14} />} label="Work" detail="Tasks, issues and actions" selected={page !== undefined} onClick={() => open(lastPage())} />;
}

/** The switch over Tasks, Issues and Actions: the lists of Work. */
export function WorkSwitch({ page }: { page: WorkPage }) {
  const open = useOpenWork();
  const board = useApp((s) => s.board.enabled);
  if (!board) return null;
  const options = [
    { value: 'tasks' as const, label: 'Tasks', icon: 'task' as const },
    { value: 'issues' as const, label: 'Issues', icon: 'issue' as const },
    { value: 'actions' as const, label: 'Actions', icon: 'pulse' as const },
  ];
  return (
    <div className={w.switch}>
      <Segmented<WorkPage> label="Work" value={page} onChange={open} options={options} />
    </div>
  );
}

/** A Work list with its switch above it. */
export function WorkFrame({ page, children }: { page: WorkPage; children: React.ReactNode }) {
  return (
    <div className={w.frame}>
      <WorkSwitch page={page} />
      <div className={w.page}>{children}</div>
    </div>
  );
}
