import { describe, expect, it } from 'vitest';
import { timelineDayLabel, timelineDays } from '../packages/mac/src/initiatives/initiatives-model.js';

const NOW = new Date(2026, 10, 26, 15, 0);

describe('initiative timeline', () => {
  it('groups dated lines by day, newest first as written', () => {
    const days = timelineDays(['2026-11-26: scheduled a follow-up', '2026-11-25: first check-in', '2026-11-25: initiative created', '2026-11-11: Natalia: wants a ticket'], NOW);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Wed 11 Nov']);
    expect(days[1]!.entries).toEqual(['first check-in', 'initiative created']);
    expect(days[2]!.entries).toEqual(['Natalia: wants a ticket']);
  });

  it('keeps lines without a date as they are', () => {
    expect(timelineDays(['something happened'], NOW)).toEqual([{ key: '', label: 'Undated', entries: ['something happened'] }]);
  });

  it('adds the year only for another year', () => {
    expect(timelineDayLabel('2025-12-31', NOW)).toBe('Wed, 31 Dec 2025');
  });
});
