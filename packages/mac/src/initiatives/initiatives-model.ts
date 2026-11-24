import { type EpicStatus, type EpicTickets, type InitiativeView, type MeetingRef, type PrState, type SlackRef, type TicketCategory, lastCheckInAt, openSuggestions, progressShare } from '@beluga/core/initiatives/model.js';

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

export const progressPercent = (progress: EpicStatus | undefined): number => Math.round((progressShare(progress) ?? 0) * 100);

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

const filled = (rows: readonly RefRow[]): RefRow[] => rows.filter((row) => row.value.trim());

export const slackEntries = (rows: readonly RefRow[]): SlackRef[] => filled(rows).map((row) => ({ ref: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}) }));

export const meetingEntries = (rows: readonly RefRow[]): MeetingRef[] => filled(rows).map((row) => ({ match: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}) }));

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

export const ticketsWords = (tickets: EpicTickets): string => {
  const total = tickets.tickets.length;
  const done = tickets.tickets.filter((t) => t.statusCategory === 'done').length;
  const prs = tickets.tickets.reduce((n, t) => n + t.prs.filter((pr) => pr.state === 'open' || pr.state === 'draft').length, 0);
  return [`${total} ${total === 1 ? 'ticket' : 'tickets'}`, `${done} done`, prs ? `${prs} open ${prs === 1 ? 'pull request' : 'pull requests'}` : ''].filter(Boolean).join(' · ');
};

export const prName = (pr: { readonly number?: number | undefined; readonly url: string }): string => {
  if (pr.number) return `#${pr.number}`;
  const fromUrl = /\/(\d+)\/?$/.exec(pr.url)?.[1];
  return fromUrl ? `#${fromUrl}` : 'PR';
};
