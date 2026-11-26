import { useSyncExternalStore } from 'react';
import { type InitiativeView, openSuggestions, pendingDrafts } from '@beluga/core/initiatives/model.js';
import { unreadNews } from '@beluga/core/initiatives/watches.js';

/** The page's areas: one shows at a time under the header. */
export type InitiativeArea = 'overview' | 'work' | 'people' | 'timeline' | 'sources';

const AREAS: readonly InitiativeArea[] = ['overview', 'work', 'people', 'timeline', 'sources'];
const LABELS: Readonly<Record<InitiativeArea, string>> = { overview: 'Overview', work: 'Work', people: 'People', timeline: 'Timeline', sources: 'Sources' };
const KEY = 'beluga.initiativeAreas';
const listeners = new Set<() => void>();

const isArea = (value: string | undefined): value is InitiativeArea => AREAS.includes(value as InitiativeArea);

const readAll = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const areaOf = (slug: string): InitiativeArea => {
  const kept = readAll()[slug];
  return isArea(kept) ? kept : 'overview';
};

/** Keeps the area picked on an initiative, so it opens there next time. */
export const rememberArea = (slug: string, area: InitiativeArea): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [slug]: area }));
  } catch {
    // No storage: it opens on Overview next time.
  }
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useInitiativeArea = (slug: string): InitiativeArea => useSyncExternalStore(subscribe, () => areaOf(slug));

/** What each area waits on you for: open suggestions, unread news from follow-ups, updates to send. */
export const areaOptions = (item: InitiativeView): { value: InitiativeArea; label: string; count?: number }[] => {
  const counts: Partial<Record<InitiativeArea, number>> = {
    overview: openSuggestions(item).length,
    work: unreadNews(item.watches ?? []).length,
    people: pendingDrafts(item).length,
  };
  return AREAS.map((value) => ({ value, label: LABELS[value], ...(counts[value] ? { count: counts[value] } : {}) }));
};
