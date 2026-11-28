import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { type IssueStatus, PRIORITY_INFO, type Priority, STATUS_INFO, asksPrivate, boardOf, issueById, reposOf } from '@beluga/core/board/model.js';
import { agentForChoice } from '@beluga/ui/agent-choice.js';
import { YOUR_AGENT, useAgentEntries } from '../components/agent-options.js';
import { Checkbox, Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { useBoxSuggestions } from '../chat/BoxSuggestions.js';
import { MentionHighlighter } from '../chat/MentionHighlighter.js';
import { Icon } from '../components/Icon.js';
import f from '../components/form.module.css';
import { cx } from '../components/ui.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import { useProjectsState } from '../lib/projects-state.js';
import { stillLoading } from '../lib/projects-state-model.js';
import { LOADING_PROJECTS } from '../work/NoProjects.js';
import { PriorityIcon } from './marks.js';
import { useSharedWith } from './parts.js';
import { assigneeChoices, boardChoices } from './tasks-model.js';
import { useTaggable } from './use-taggable.js';
import { useBoard, usePeople, useSelf, useSolo, useTaskActions, useTasksPrefs } from './use-tasks.js';
import n from './NewTaskSheet.module.css';
import { chordLabel } from '../lib/shortcuts-model.js';
import { useActions } from '../lib/actions.js';

/** The priority scale, left to right: its keys are 0 to 4. */
const SCALE: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

/**
 * A new task: say what you want in one box and Claude writes its title and goal and picks its
 * labels (or write them yourself), and how much it matters on a scale if you like. The box can ask
 * for several tasks, or an epic with its parts, and say who each is for: Create makes them all
 * (BLG-319), no chat in between. "@" in the box names a teammate or a friend, so Claude knows who
 * you mean (BLG-342). It goes on the
 * board and in the column you opened it from, running in the repo you pick when the board covers
 * several. Start with your agent makes the worktree (in that repo) and puts your agent on it.
 * Agent (BLG-497): who works it when it starts (Codex, a local model…); your default unless you pick.
 */
interface NewTaskProps {
  boardId?: string;
  projectId?: string;
  status?: IssueStatus;
  parent?: string;
  close: () => void;
}

export function NewTaskSheet(props: NewTaskProps) {
  // Opened while Beluga is still finding your projects: wait for them, so the form starts from the ones you have.
  if (stillLoading(useProjectsState())) return <FormSheet title="New Task" intro={LOADING_PROJECTS} submitLabel="Done" hideSubmit onSubmit={() => undefined} onCancel={props.close} />;
  return <NewTaskForm {...props} />;
}

function NewTaskForm({ boardId, projectId, status, parent, close }: NewTaskProps) {
  const board = useBoard();
  const prefs = useTasksPrefs();
  const allProjects = useApp((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => p.root && !p.error), [allProjects]);
  const self = useSelf();
  const { client } = useBeluga();
  const { api, act, open } = useTaskActions();
  const actions = useActions();
  const parentIssue = parent ? issueById(board, parent) : undefined;
  const boards = useMemo(() => boardChoices(board, projects), [board, projects]);
  const known = (id: string | undefined): id is string => Boolean(id && boards.some((b) => b.id === id));
  // The board you're on (a sub-task: its parent's), else the repo's own, else the one you last looked at.
  const firstBoard = parentIssue ? boardOf(parentIssue) : [boardId, projectId, prefs.board, prefs.project].find(known) ?? boards[0]?.id ?? '';
  const [onBoard, setOnBoard] = useState(firstBoard);
  const repos = useMemo(() => {
    const covered = reposOf(board, onBoard).filter((r) => projects.some((p) => p.id === r));
    return parentIssue && !covered.includes(parentIssue.projectId) ? [...covered, parentIssue.projectId] : covered;
  }, [board, onBoard, projects, parentIssue]);
  // The repo it runs in: the one asked for, the parent's, the one you were last in, else the board's own.
  const repoFor = (list: readonly string[]): string => [projectId, parentIssue?.projectId, prefs.project].find((r): r is string => Boolean(r && list.includes(r))) ?? list[0] ?? '';
  const [describe, setDescribe] = useState('');
  const [mine, setMine] = useState(false);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [chosenRepo, setProject] = useState(() => repoFor(repos));
  const project = repos.includes(chosenRepo) ? chosenRepo : repoFor(repos);
  const column: IssueStatus = status ?? parentIssue?.status ?? (prefs.scope === 'backlog' ? 'backlog' : 'todo');
  const [priority, setPriority] = useState<Priority>('none');
  const people = usePeople(project);
  const choices = assigneeChoices(self, people);
  const [assignee, setAssignee] = useState('');
  const [start, setStart] = useState(false);
  const agents = useAgentEntries();
  const runtimes = useApp((s) => s.runtimes);
  const [agent, setAgent] = useState(YOUR_AGENT);
  // Only you see it (BLG-501): words asking for it pick it, until you pick yourself.
  const [only, setOnly] = useState<boolean>();
  const sharedWith = useSharedWith()(project);
  const asked = !mine && asksPrivate(describe);
  const forced = Boolean(parentIssue?.private);
  const isPrivate = forced || (only ?? asked);
  const solo = useSolo(project);
  const tagged = useTaggable(project, self.id, projects.find((p) => p.id === project)?.name);
  const box = useRef<HTMLTextAreaElement>(null);
  const tags = useBoxSuggestions({ text: describe, setText: setDescribe, people: tagged.people, className: n.suggestions });
  if (!projects.length) {
    // The sidebar's own "Add a Project…", one click away (every OS has it; not every one has a File menu).
    const addProject = (): void => {
      close();
      actions.run({ type: 'add_project' });
    };
    return <FormSheet title="New Task" intro="Tasks belong to a project: a folder with your code. Add one first." submitLabel="Add a Project…" onSubmit={addProject} onCancel={close} />;
  }
  // Where it goes, quietly: the board (unless you pick it below) and the column; the repo when the board has several.
  const pickBoard = !known(boardId) && !parentIssue && boards.length > 1;
  const pickRepo = repos.length > 1;
  const where = [pickBoard ? '' : boards.find((b) => b.id === onBoard)?.name, STATUS_INFO[start ? 'todo' : column].label].filter(Boolean).join(' · ');
  return (
    <FormSheet
      title={parentIssue ? `New Sub-task of ${parentIssue.key}` : 'New Task'}
      icon="task"
      intro={parentIssue ? `Under “${parentIssue.title}” · ${where}` : where}
      submitLabel={start ? 'Create and Start' : 'Create Task'}
      canSubmit={Boolean((mine ? title.trim() : describe.trim()) && project)}
      width={560}
      onCancel={close}
      footer={<Checkbox checked={start} onChange={setStart} label="Start with your agent" detail="A new worktree, with your agent working on it" />}
      onSubmit={async () => {
        const who = choices.find((c) => c.key === assignee)?.assignee;
        const created = await api.create({
          projectId: project,
          board: onBoard,
          ...(mine ? { title: title.trim(), ...(goal.trim() ? { goal: goal.trim() } : {}) } : { describe: describe.trim() }),
          status: start ? 'todo' : column,
          priority,
          ...(who ? { assignee: who } : {}),
          ...(parentIssue ? { parent: parentIssue.id } : {}),
          ...(agent !== YOUR_AGENT ? { agent: agentForChoice(agent, runtimes) } : {}),
          private: isPrivate,
        });
        close();
        // (The sheet is gone: a problem starting shows as a toast, and the task is there to start again.)
        if (start) await act(() => api.start(created.id, { claude: true }));
        else {
          toast(client, `Created ${created.key}${created.private ? ', private' : ''}`, 'success');
          if (parentIssue) open(parentIssue);
        }
      }}
    >
      {mine ? (
        <>
          <Field label="Title" htmlFor="task-title">
            <TextInput id="task-title" value={title} onChange={setTitle} maxLength={200} placeholder="Rate-limit the login endpoint" data-autofocus />
          </Field>
          <Field label="Goal" htmlFor="task-goal" hint={`What it’s for and what done looks like. Markdown; ${chordLabel('Cmd+Enter')} creates it.`}>
            <TextArea id="task-goal" value={goal} onChange={setGoal} rows={4} placeholder="10 tries a minute per IP, then 429. Logins from the app keep working." />
          </Field>
        </>
      ) : (
        <div className={n.describe}>
          <div className={n.boxWrap}>
            <MentionHighlighter text={describe} world={tagged.world} input={box} className={cx(f.input, f.area, n.box, n.layer)} />
            <TextArea
              ref={box}
              aria-label="Describe the task"
              aria-haspopup="listbox"
              aria-expanded={tags.open}
              className={cx(n.box, n.overLayer)}
              value={describe}
              onChange={setDescribe}
              rows={4}
              maxLength={8000}
              placeholder={solo ? 'Say what you want done: one task, or a few. Your agent writes them.' : 'Say what you want done: one task, or a few and who each is for. Your agent writes them.'}
              onInput={(e) => grow(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                tags.onKey(e);
              }}
              data-autofocus
            />
            {tags.list}
          </div>
          <div className={n.hint}>
            {solo
              ? `Ask for several tasks, or an epic with its parts, and Create makes them all. @ names a friend. ${chordLabel('Cmd+Enter')} creates it.`
              : `Ask for several tasks, or an epic with its parts, and name who each is for (@ picks them): Create makes and assigns them all. ${chordLabel('Cmd+Enter')} creates it.`}
          </div>
        </div>
      )}
      <button type="button" className={n.disclosure} aria-expanded={mine} onClick={() => setMine(!mine)}>
        <Icon name={mine ? 'chevronDown' : 'chevronRight'} size={10} />
        {mine ? 'Let your agent write the title and goal' : 'Write title and goal myself'}
      </button>
      {pickBoard ? (
        <Field label="Board">
          <Popup label="Board" value={onBoard} options={boards.map((b) => ({ value: b.id, label: b.name }))} onChange={setOnBoard} />
        </Field>
      ) : null}
      {/* A board of several repos: which one it runs in (its worktree is made there). */}
      {pickRepo ? (
        <Field label="Repo">
          <Popup label="Repo" value={project} options={repos.map((r) => ({ value: r, label: projects.find((p) => p.id === r)?.name ?? r }))} onChange={setProject} />
        </Field>
      ) : null}
      <Field label="Priority">
        <PriorityScale value={priority} onChange={setPriority} />
      </Field>
      {/* Only worth asking when someone else would see it (teammates, Linear), or it's under a private task. */}
      {sharedWith || forced ? (
        <Field label="Who Sees It" hint={forced ? 'Its parent is private, so it is too' : isPrivate ? (only === undefined ? 'Your words asked to keep it to yourself' : undefined) : sharedWith ? `Everyone on the team: ${sharedWith}, and whoever they team up with` : undefined}>
          <div className={n.scale} role="radiogroup" aria-label="Who sees it">
            <button type="button" role="radio" aria-checked={!isPrivate} disabled={forced} className={cx(n.step, !isPrivate && n.stepOn)} onClick={() => setOnly(false)}>
              <Icon name="people" size={12} />
              Your Team
            </button>
            <button type="button" role="radio" aria-checked={isPrivate} className={cx(n.step, isPrivate && n.stepOn)} onClick={() => setOnly(true)}>
              <Icon name="lock" size={12} />
              Only You
            </button>
          </div>
        </Field>
      ) : null}
      {/* Alone on a project, every task is yours and your Claude's: nothing to choose. */}
      {solo ? null : (
        <Field label="Assignee">
          <Popup label="Assignee" value={assignee} options={[{ value: '', label: 'No one' }, ...choices.map((c) => ({ value: c.key, label: c.label }))]} onChange={setAssignee} />
        </Field>
      )}
      <Field label="Agent" hint="Who works on it when it starts: its worktree runs this agent and model.">
        <Popup label="Agent" value={agent} options={agents} onChange={setAgent} />
      </Field>
    </FormSheet>
  );
}

/** The describe box grows with what you write (up to a point; then it scrolls). */
function grow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
}

/** None · Low · Medium · High · Urgent in one click; on the scale, 0 to 4 and the arrows pick. */
function PriorityScale({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  const at = SCALE.indexOf(value);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const digit = /^[0-4]$/.test(e.key) ? Number(e.key) : undefined;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const next = digit ?? (step ? Math.max(0, Math.min(SCALE.length - 1, at + step)) : undefined);
    if (next === undefined) return;
    e.preventDefault();
    onChange(SCALE[next]!);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={n.scale} role="radiogroup" aria-label="Priority" onKeyDown={onKeyDown}>
      {SCALE.map((p, i) => (
        <button key={p} type="button" role="radio" aria-checked={p === value} tabIndex={p === value ? 0 : -1} className={cx(n.step, p === value && n.stepOn)} title={`${PRIORITY_INFO[p].label} (${i})`} onClick={() => onChange(p)}>
          <PriorityIcon priority={p} size={12} />
          {p === 'none' ? 'None' : PRIORITY_INFO[p].label}
        </button>
      ))}
    </div>
  );
}
