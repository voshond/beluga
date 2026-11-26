import { type InitiativeView, openSuggestions } from '../../../../src/core/initiatives/model.js';
import { progressPercent, progressWords, sortedInitiatives } from './initiatives-model.js';

export type SidebarInitiative = {
  readonly slug: string;
  readonly name: string;
  readonly status: InitiativeView['status'];
  readonly chat: string;
  readonly asks: number;
  readonly done: number;
  readonly inProgress: number;
  readonly detail: string;
};

const QUIET_STATUSES: ReadonlySet<string> = new Set(['paused', 'shipped']);

export const isQuietInitiative = (status: string): boolean => QUIET_STATUSES.has(status);

const detailOf = (item: InitiativeView): string => {
  const progress = progressWords(item.progress);
  return item.status === 'active' ? progress : `${item.status[0]!.toUpperCase()}${item.status.slice(1)} · ${progress}`;
};

export const sidebarInitiatives = (items: readonly InitiativeView[]): SidebarInitiative[] =>
  sortedInitiatives(items)
    .filter((item) => item.status !== 'archived')
    .map((item) => ({
      slug: item.slug,
      name: item.name,
      status: item.status,
      chat: item.chats.active,
      asks: openSuggestions(item).length,
      done: progressPercent(item.progress),
      inProgress: progressPercent(item.progress, 'inProgress'),
      detail: detailOf(item),
    }));

export const openSuggestionTotal = (rows: readonly Pick<SidebarInitiative, 'asks'>[]): number => rows.reduce((total, row) => total + row.asks, 0);
