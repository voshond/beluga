import type { ConvSummary, WorkView } from './link/protocol';

/** Work's categories as the phone draws them (the daemon decides each chat's: src/core/triage). Pure. */

type Project = WorkView['projects'][number];
export type TriageOption = 'settle' | 'snooze' | 'wake' | 'unsettle';

export interface CategorySections {
  /** Still by project, as Work is without categories. What has no category (the room) stays here. */
  readonly active: readonly Project[];
  readonly working: readonly ConvSummary[];
  readonly snoozed: readonly ConvSummary[];
  readonly settled: readonly ConvSummary[];
}

const OPTIONS: Record<NonNullable<ConvSummary['category']>, readonly TriageOption[]> = {
  active: ['settle', 'snooze'],
  // A running turn can't settle: the daemon refuses, so the sheet doesn't offer it.
  working: ['snooze'],
  snoozed: ['wake'],
  settled: ['unsettle'],
};

const SETTLED_WORDS: Record<NonNullable<ConvSummary['settledWhy']>, string> = {
  you: 'Settled by you',
  pr_merged: 'PR merged',
  merged_here: 'Merged here',
  idle: 'Idle for days',
};

export function categorySections(projects: readonly Project[]): CategorySections {
  const all = projects.flatMap((p) => p.conversations);
  const inCategory = (category: ConvSummary['category']) => all.filter((c) => c.category === category).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const isActive = (c: ConvSummary) => !c.category || c.category === 'active';
  return {
    // A project that only had others moves out; one with nothing in it yet stays, for its first worktree.
    active: projects.filter((p) => !p.conversations.length || p.conversations.some(isActive)).map((p) => ({ ...p, conversations: p.conversations.filter(isActive) })),
    working: inCategory('working'),
    snoozed: inCategory('snoozed'),
    settled: inCategory('settled'),
  };
}

/** What a chat's sheet offers; nothing for what has no category. */
export const triageOptions = (c: Pick<ConvSummary, 'category'>): readonly TriageOption[] => (c.category ? OPTIONS[c.category] : []);

export const settledWords = (why: ConvSummary['settledWhy']): string => (why ? SETTLED_WORDS[why] : 'Settled');

/** A time to come: its hour today, with its day after that. */
export function whenWords(at: number, now = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
