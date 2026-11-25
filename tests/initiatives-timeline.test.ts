import { describe, expect, it } from 'vitest';
import { timelineEntryOf } from '../src/core/initiatives/model.js';
import { activityLevel, activityWeeks, ticketParts, timelineDayLabel, timelineDays } from '../packages/mac/src/initiatives/initiatives-model.js';

const NOW = new Date(2026, 10, 26, 15, 0);

const entries = ['2026-11-26 [meeting]: scheduled a follow-up', '2026-11-25 [check-in]: first check-in', '2026-11-25 [created]: initiative created', '2026-11-11: Natalia: wants a ticket'].map(timelineEntryOf);

describe('initiative timeline', () => {
  it('groups entries by day, newest first as written', () => {
    const days = timelineDays(entries, NOW);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Wed 11 Nov']);
    expect(days[1]!.entries.map((e) => e.text)).toEqual(['first check-in', 'initiative created']);
    expect(days[2]!.entries[0]!.kind).toBe('event');
  });

  it('labels lines without a date as undated', () => {
    expect(timelineDays([timelineEntryOf('something happened')], NOW)[0]!.label).toBe('Undated');
  });

  it('adds the year only for another year', () => {
    expect(timelineDayLabel('2025-12-31', NOW)).toBe('Wed, 31 Dec 2025');
  });
});

describe('initiative activity grid', () => {
  it('lays out weeks Monday to Sunday ending this week, counting each day', () => {
    const weeks = activityWeeks(entries, NOW, 4);
    expect(weeks).toHaveLength(4);
    const last = weeks.at(-1)!.cells;
    expect(last.map((c) => c.key)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    expect(last[2]).toMatchObject({ count: 2, level: 2, future: false });
    expect(last[3]).toMatchObject({ count: 1, level: 1 });
    expect(last[4]!.future).toBe(true);
  });

  it('names a month on the week it starts', () => {
    expect(activityWeeks([], NOW, 8).map((w) => w.month ?? '')).toEqual(['Oct', '', '', '', 'Nov', '', '', '']);
  });

  it('steps the shade up with the count', () => {
    expect([0, 1, 2, 4, 9].map(activityLevel)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('ticket keys in timeline text', () => {
  it('splits the keys out as chips', () => {
    expect(ticketParts('RUN-53 and RUN-54 are in progress')).toEqual([{ text: 'RUN-53', ticket: 'RUN-53' }, { text: ' and ' }, { text: 'RUN-54', ticket: 'RUN-54' }, { text: ' are in progress' }]);
    expect(ticketParts('R-2026-04040 / CP-2026-00982 stay text')).toEqual([{ text: 'R-2026-04040 / CP-2026-00982 stay text' }]);
  });
});
