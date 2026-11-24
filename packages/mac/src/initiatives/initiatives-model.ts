import { type EpicStatus, type InitiativeView, lastCheckInAt, openSuggestions, progressShare } from '@beluga/core/initiatives/model.js';

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
