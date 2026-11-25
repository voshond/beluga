import { type DocRef, type EpicStatus, type EpicTickets, type InitiativeTask, type InitiativeTasks, type InitiativeView, type MeetingRef, type PrState, type SlackRef, type Ticket, type TicketCategory, docKindOf, isSubTask, lastCheckInAt, openSuggestions, progressShare } from '@beluga/core/initiatives/model.js';

export const INITIATIVE_VIEWS: ReadonlySet<string> = new Set(['initiatives', 'initiative_page']);

export const isInitiativeView = (kind: string): boolean => INITIATIVE_VIEWS.has(kind);

export const progressWords = (progress: EpicStatus | undefined): string => {
  if (!progress) return 'No check-in yet';
  if (progress.total === 0) return 'No tickets in the epics yet';
  return `${progress.done} of ${progress.total} done`;
};

export const progressDetail = (progress: EpicStatus | undefined): string[] => {
  if (!progress) return [];
  return [progress.inProgress ? `${progress.inProgress} in progress` : '', progress.blocked ? `${progress.blocked} blocked` : '', progress.stale ? `${progress.stale} stale` : ''].filter(Boolean);
};

export const progressPercent = (progress: EpicStatus | undefined, part: 'done' | 'inProgress' = 'done'): number => {
  if (part === 'done') return Math.round((progressShare(progress) ?? 0) * 100);
  if (!progress || progress.total <= 0) return 0;
  return Math.round(Math.min(1, progress.inProgress / progress.total) * 100);
};

export const splitList = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);

export const epicKeys = (text: string): string[] => splitList(text).map((key) => key.toUpperCase());

export const sidebarLine = (items: readonly InitiativeView[]): string => {
  const live = items.filter((i) => i.status !== 'archived');
  if (!live.length) return 'Drive a thing to ship';
  const asks = live.reduce((n, i) => n + openSuggestions(i).length, 0);
  const count = `${live.length} ${live.length === 1 ? 'initiative' : 'initiatives'}`;
  return asks ? `${count} · ${asks} ${asks === 1 ? 'suggestion' : 'suggestions'}` : count;
};

export const lastCheckInWords = (item: Pick<InitiativeView, 'progress'>, ago: (at: number) => string): string => {
  const at = lastCheckInAt(item);
  return at === undefined ? 'Never checked in' : `Checked in ${ago(at)}`;
};

export const sortedInitiatives = (items: readonly InitiativeView[]): InitiativeView[] => {
  const rank = (i: InitiativeView): number => (i.status === 'archived' ? 2 : i.status === 'shipped' ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
};

export type RefRow = {
  readonly id: number;
  readonly value: string;
  readonly label: string;
};

let lastRowId = 0;

export const newRow = (value = '', label = ''): RefRow => {
  lastRowId += 1;
  return { id: lastRowId, value, label };
};

export const slackRows = (entries: readonly SlackRef[]): RefRow[] => entries.map((entry) => newRow(entry.ref, entry.label ?? ''));

export const meetingRows = (entries: readonly MeetingRef[]): RefRow[] => entries.map((entry) => newRow(entry.match, entry.label ?? ''));

export const docRows = (entries: readonly DocRef[]): RefRow[] => entries.map((entry) => newRow(entry.ref, entry.label ?? ''));

const filled = (rows: readonly RefRow[]): RefRow[] => rows.filter((row) => row.value.trim());

export const slackEntries = (rows: readonly RefRow[]): SlackRef[] => filled(rows).map((row) => ({ ref: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}) }));

export const meetingEntries = (rows: readonly RefRow[]): MeetingRef[] => filled(rows).map((row) => ({ match: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}) }));

export const docEntries = (rows: readonly RefRow[]): DocRef[] => filled(rows).map((row) => ({ ref: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}), kind: docKindOf(row.value) }));

export const pastedValues = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

export const withPasted = (rows: readonly RefRow[], id: number, values: readonly string[]): RefRow[] => {
  const [first, ...rest] = values;
  if (first === undefined) return [...rows];
  return rows.flatMap((row) => (row.id === id ? [{ ...row, value: first }, ...rest.map((value) => newRow(value))] : [row]));
};

export const CATEGORY_LABEL: Readonly<Record<TicketCategory, string>> = { todo: 'To do', inProgress: 'In progress', done: 'Done' };

export const PR_STATE_LABEL: Readonly<Record<PrState, string>> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

const doneOf = (tickets: readonly Ticket[]): number => tickets.filter((t) => t.statusCategory === 'done').length;

export const subTasksWords = (subTasks: readonly Ticket[]): string => (subTasks.length ? `${doneOf(subTasks)}/${subTasks.length} sub-tasks` : '');

export const ticketsWords = (tickets: EpicTickets): string => {
  const subTasks = tickets.tickets.filter((t) => isSubTask(t, tickets.tickets));
  const main = tickets.tickets.filter((t) => !subTasks.includes(t));
  const prs = tickets.tickets.reduce((n, t) => n + t.prs.filter((pr) => pr.state === 'open' || pr.state === 'draft').length, 0);
  return [
    `${main.length} ${main.length === 1 ? 'ticket' : 'tickets'}`,
    `${doneOf(main)} done`,
    subTasks.length ? `${subTasks.length} ${subTasks.length === 1 ? 'sub-task' : 'sub-tasks'}, ${doneOf(subTasks)} done` : '',
    prs ? `${prs} open ${prs === 1 ? 'pull request' : 'pull requests'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
};

export const prName = (pr: { readonly number?: number | undefined; readonly url: string }): string => {
  if (pr.number) return `#${pr.number}`;
  const fromUrl = /\/(\d+)\/?$/.exec(pr.url)?.[1];
  return fromUrl ? `#${fromUrl}` : 'PR';
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const dayWords = (iso: string): string => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(DATE_ONLY.test(iso) ? { timeZone: 'UTC' } : {}) });
};

const momentWords = (iso: string): string => {
  if (DATE_ONLY.test(iso)) return dayWords(iso);
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
};

export const taskWhen = (task: Pick<InitiativeTask, 'scheduled' | 'due' | 'pending'>): string => {
  if (task.pending) return task.pending === 'complete' ? 'Completing…' : 'Reopening…';
  if (task.scheduled) return momentWords(task.scheduled);
  return task.due ? `due ${dayWords(task.due)}` : '';
};

export const tasksWords = (tasks: InitiativeTasks): string => {
  const open = tasks.tasks.filter((t) => !t.done);
  const scheduled = open.filter((t) => t.scheduled).length;
  const done = tasks.tasks.length - open.length;
  return [`${open.length} open`, scheduled ? `${scheduled} scheduled` : '', done ? `${done} done` : ''].filter(Boolean).join(' · ');
};
