import { Component, type ReactNode, lazy, Suspense, useRef } from 'react';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Button, Empty } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { useMaking } from '../lib/making.js';
import { ChatView } from '../views/ChatView.js';
import { ChatLog } from '../chat/ChatLog.js';
import views from '../views/views.module.css';
import { Toolbar } from './Toolbar.js';
import { ProjectCenter, WorkspaceCenter } from './panel/FocusView.js';
import { TerminalDrawer } from './panel/TerminalDrawer.js';
import { WorkFrame } from '../work/WorkNav.js';
import s from './Shell.module.css';
import side from './Sidebar.module.css';
import { SharedPlanPage } from '../team/SharedPlans.js';
import { CallRoom } from '../call/CallRoom.js';

const OverviewView = lazy(() => import('../views/OverviewView.js').then((m) => ({ default: m.OverviewView })));
const SearchView = lazy(() => import('../views/SearchView.js').then((m) => ({ default: m.SearchView })));
const UsageView = lazy(() => import('../views/UsageView.js').then((m) => ({ default: m.UsageView })));
const FilesView = lazy(() => import('../views/FilesView.js').then((m) => ({ default: m.FilesView })));
const DiffView = lazy(() => import('../views/DiffView.js').then((m) => ({ default: m.DiffView })));
const ConversationView = lazy(() => import('../network/ConversationView.js').then((m) => ({ default: m.ConversationView })));
const TerminalView = lazy(() => import('../views/TerminalView.js').then((m) => ({ default: m.TerminalView })));
const ActivityView = lazy(() => import('../claude-code/ActivityView.js').then((m) => ({ default: m.ActivityView })));
const ProjectHome = lazy(() => import('../views/ProjectHome.js').then((m) => ({ default: m.ProjectHome })));
const HistoryView = lazy(() => import('../views/history/HistoryView.js').then((m) => ({ default: m.HistoryView })));
const WorktreesView = lazy(() => import('../views/worktrees/WorktreesView.js').then((m) => ({ default: m.WorktreesView })));
const RequestsView = lazy(() => import('../gateway/RequestsView.js').then((m) => ({ default: m.RequestsView })));
const TasksView = lazy(() => import('../tasks/TasksView.js').then((m) => ({ default: m.TasksView })));
const TaskPage = lazy(() => import('../tasks/TaskPage.js').then((m) => ({ default: m.TaskPage })));
const IssuesView = lazy(() => import('../issues/IssuesView.js').then((m) => ({ default: m.IssuesView })));
const IssuePage = lazy(() => import('../issues/IssuePage.js').then((m) => ({ default: m.IssuePage })));
const ActionsView = lazy(() => import('../ci/ActionsView.js').then((m) => ({ default: m.ActionsView })));
const RunPage = lazy(() => import('../ci/RunPage.js').then((m) => ({ default: m.RunPage })));
const PlansView = lazy(() => import('../plans/PlansView.js').then((m) => ({ default: m.PlansView })));
const PlanPage = lazy(() => import('../plans/PlanPage.js').then((m) => ({ default: m.PlanPage })));
const SentinelPage = lazy(() => import('../sentinel/SentinelPage.js').then((m) => ({ default: m.SentinelPage })));
const SentinelRunPage = lazy(() => import('../sentinel/RunPage.js').then((m) => ({ default: m.RunPage })));
const SentinelHome = lazy(() => import('../sentinel/SentinelHome.js').then((m) => ({ default: m.SentinelHome })));
const PhoneView = lazy(() => import('../phone/PhoneView.js').then((m) => ({ default: m.PhoneView })));

/**
 * A worktree being made: its page shows at once with what you asked (BLG-531), and becomes its
 * conversation when git is done.
 */
function MakingWorktree() {
  const ws = useApp((st) => (st.view.kind === 'workspace' ? findWorkspace(st.projects, st.view.id) : undefined));
  const asked = useApp((st) => (ws ? st.log.some((l) => l.channel === `ws:${ws.id}`) : false));
  if (!ws) return null;
  const from = ws.base ?? 'the latest origin';
  if (!asked) {
    return (
      <Empty
        icon="branch"
        mark={<span className={side.making} style={{ width: 18, height: 18 }} aria-hidden="true" />}
        title={`Making ${ws.name}…`}
        detail={`A new worktree from ${from}. Its conversation opens here in a moment; anything you asked your agent starts then.`}
      />
    );
  }
  return (
    <div className={views.chat}>
      <ChatLog key={ws.id} channel={`ws:${ws.id}`} />
      <div className={s.makingLine} role="status">
        <span className={side.making} aria-hidden="true" />
        Making {ws.name} from {from}. Your agent starts as soon as its folder is ready.
      </div>
    </div>
  );
}

function Route() {
  const view = useApp((st) => st.view);
  const making = useMaking();
  if (making) return <MakingWorktree />;
  switch (view.kind) {
    case 'room':
      // The room's chat with its call around it (BLG-716).
      return (
        <CallRoom id="room">
          <ChatView />
        </CallRoom>
      );
    case 'assistant':
    case 'draft':
    case 'draft_worktree':
      return <ChatView />;
    case 'workspace':
      // Always the conversation; its changes, files and terminal are in the right panel (a diff or a file can take the center for a while).
      return <WorkspaceCenter />;
    case 'shared':
      // Its Files tab browses and searches.
      return view.tab === 'chat' ? <ChatView /> : view.tab === 'diff' ? <DiffView /> : <FilesView />;
    case 'overview':
      return <OverviewView />;
    case 'search':
      return <SearchView />;
    case 'usage':
      return <UsageView />;
    case 'files':
      return <FilesView />;
    case 'terminal':
      return <TerminalView />;
    case 'phone':
      return <PhoneView />;
    case 'conversation':
      return <ConversationView id={view.id} />;
    case 'claude_code':
      return <ActivityView />;
    case 'requests':
      return <RequestsView />;
    case 'tasks':
      return <WorkFrame page="tasks"><TasksView /></WorkFrame>;
    case 'task':
      return <TaskPage key={view.id} id={view.id} />;
    case 'issues':
      return <WorkFrame page="issues"><IssuesView /></WorkFrame>;
    case 'gh_issue':
      return <IssuePage key={`${view.projectId}#${view.number}`} projectId={view.projectId} number={view.number} />;
    case 'actions':
      return <WorkFrame page="actions"><ActionsView /></WorkFrame>;
    case 'gh_run':
      return <RunPage key={`${view.projectId}#${view.runId}`} projectId={view.projectId} runId={view.runId} />;
    case 'plans':
      return <WorkFrame page="plans"><PlansView /></WorkFrame>;
    case 'plan':
      return <PlanPage key={view.id} id={view.id} task={view.task} />;
    case 'team_plan':
      return <WorkFrame page="plans"><SharedPlanPage key={`${view.owner}/${view.id}`} owner={view.owner} id={view.id} /></WorkFrame>;
    // Sentinel is one page (BLG-300): its board is on it, its chat docks beside it; the old views land there.
    case 'sentinel_chat':
      // Asked from a sentinel's own page: that page stays, the chat beside it.
      if (view.about) return <SentinelPage key={view.about} id={view.about} />;
      return <SentinelHome />;
    case 'sentinel':
    case 'dashboard':
      return <SentinelHome />;
    case 'sentinel_page':
      return <SentinelPage key={view.id} id={view.id} />;
    case 'sentinel_run':
      return <SentinelRunPage key={view.runId} runId={view.runId} />;
    case 'worktrees':
      return <WorktreesView projectId={view.projectId} />;
    case 'project':
      return view.page === 'history' ? <HistoryView projectId={view.id} /> : (
        <ProjectCenter>
          <ProjectHome id={view.id} />
        </ProjectCenter>
      );
  }
}

/** A view that breaks shows what happened and a way back, instead of blanking the window. */
class ViewBoundary extends Component<{ children: ReactNode; at: string }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override componentDidUpdate(prev: { at: string }): void {
    // Going somewhere else tries again.
    if (prev.at !== this.props.at && this.state.error) this.setState({ error: undefined });
  }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Empty
        icon="alert"
        title="This view ran into a problem"
        detail={this.state.error.message}
        action={
          <Button size="small" onClick={() => this.setState({ error: undefined })}>
            Try Again
          </Button>
        }
      />
    );
  }
}

export function Main() {
  const at = useApp((st) => JSON.stringify(st.view));
  const column = useRef<HTMLElement>(null);
  const making = useMaking();
  return (
    <main ref={column} className={s.main}>
      <Toolbar />
      <ViewBoundary at={at}>
        <Suspense fallback={<div className={s.loading} />}>
          <Route />
        </Suspense>
      </ViewBoundary>
      {/* Nothing to run in a worktree that isn't there yet. */}
      {making ? null : <TerminalDrawer column={column} />}
    </main>
  );
}
