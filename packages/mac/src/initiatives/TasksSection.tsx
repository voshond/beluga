import { activityOf } from '@beluga/ui/workspace-models.js';
import { CHECK_IN_CHAT, type InitiativeTask, type InitiativeView, initiativeChatChannel, taskGroups } from '@beluga/core/initiatives/model.js';
import { Button } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../tasks/tasks-model.js';
import { taskWhen, tasksWords } from './initiatives-model.js';
import { Section } from './InitiativeParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const DONE_SHOWN = 5;

const TaskRow = ({ slug, task }: { slug: string; task: InitiativeTask }) => {
  const a = useInitiativeActions();
  const checked = task.pending ? task.pending === 'complete' : task.done;
  const handleToggle = (): void => void a.act(() => a.api.setTaskDone(slug, task.id, !checked));
  return (
    <div role="listitem" className={s.task} data-task={task.id} data-done={checked} data-pending={task.pending}>
      <input type="checkbox" className={s.taskCheck} checked={checked} disabled={Boolean(task.pending)} onChange={handleToggle} aria-label={`${checked ? 'Reopen' : 'Complete'} ${task.title}`} />
      <span className={s.taskText}>
        <span className={s.taskTitle}>{task.title || 'Untitled task'}</span>
        {task.notes ? <span className={s.taskNotes}>{task.notes}</span> : null}
      </span>
      <span className={s.taskWhen}>{taskWhen(task)}</span>
    </div>
  );
};

const TaskGroup = ({ slug, name, tasks }: { slug: string; name: string; tasks: readonly InitiativeTask[] }) => {
  if (!tasks.length) return null;
  return (
    <div className={s.taskGroup}>
      <span className={s.taskGroupName}>{name}</span>
      <div className={s.ticketList} role="list" aria-label={name}>
        {tasks.map((task) => (
          <TaskRow key={task.id} slug={slug} task={task} />
        ))}
      </div>
    </div>
  );
};

export const TasksSection = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const now = useClock(true, 60_000);
  const fetching = useApp((st) => activityOf(st.log, initiativeChatChannel(item.slug, CHECK_IN_CHAT)).running);
  const groups = taskGroups(item.tasks?.tasks ?? []);
  const any = groups.scheduled.length + groups.unscheduled.length + groups.done.length > 0;
  const readAt = item.tasks ? Date.parse(item.tasks.at) : NaN;
  const read = item.tasks && any ? `${tasksWords(item.tasks)} · read ${Number.isFinite(readAt) ? ago(readAt, now) : 'earlier'}` : '';
  const handleRefresh = (): void => void a.act(() => a.api.refreshTasks(item.slug), 'Reading your tasks: follow it in the Check-in chat');
  const aside = (
    <Button size="small" icon="refresh" onClick={handleRefresh} disabled={fetching} aria-label="Refresh the tasks from Google Tasks">
      {fetching ? 'Refreshing…' : 'Refresh'}
    </Button>
  );
  return (
    <Section title="Tasks" aside={aside}>
      {read ? <span className={s.quiet}>{read}</span> : null}
      {any ? (
        <div className={s.taskGroups}>
          <TaskGroup slug={item.slug} name="Scheduled" tasks={groups.scheduled} />
          <TaskGroup slug={item.slug} name="Unscheduled" tasks={groups.unscheduled} />
          <TaskGroup slug={item.slug} name="Done" tasks={groups.done.slice(0, DONE_SHOWN)} />
        </div>
      ) : (
        <span className={s.quiet} role="status">
          {item.tasks ? 'None of your Google Tasks belong to this initiative yet. Ask its chat to make one.' : 'No tasks read yet. Refresh reads your Google Tasks that belong to it, and every check-in does too.'}
        </span>
      )}
    </Section>
  );
};
