import { describe, expect, it } from 'vitest';
import { clockOf, findTurns, lengthOf, marks, minuteMarks, timeline, turns, wordCount } from '../src/shared/call-notes.js';

const line = (by: string, s: number, text: string) => ({ by, name: by, at: s * 1000, text });

describe('reading long call notes (BLG-715)', () => {
  const lines = [line('bo', 1, 'Hey there'), line('bo', 4, 'can you hear me'), line('ann', 9, 'Yes, loud and clear'), line('bo', 300, 'Refunds are fine by me')];
  const all = turns(lines);

  it('one person’s phrases in a row read as one turn; a long pause starts another', () => {
    expect(all.map((t) => [t.by, t.text])).toEqual([
      ['bo', 'Hey there can you hear me'],
      ['ann', 'Yes, loud and clear'],
      ['bo', 'Refunds are fine by me'],
    ]);
    expect(turns([line('bo', 0, 'a'), line('bo', 200, 'b')])).toHaveLength(2);
  });

  it('finds every word of a search, in any case, and marks it', () => {
    expect(findTurns(all, 'REFUND fine')).toEqual([2]);
    expect(findTurns(all, '')).toEqual([]);
    expect(marks('Refunds are fine', 'refund')).toEqual([
      { text: 'Refund', hit: true },
      { text: 's are fine', hit: false },
    ]);
    // A search with regex characters is only text.
    expect(marks('a (b) c', '(b)')).toEqual([
      { text: 'a ', hit: false },
      { text: '(b)', hit: true },
      { text: ' c', hit: false },
    ]);
  });

  it('places each turn on the call’s timeline, with landmarks every few minutes', () => {
    const v = { startedAt: 0, endedAt: 600_000 };
    const stripes = timeline(v, all);
    expect(stripes.map((s) => s.by)).toEqual(['bo', 'ann', 'bo']);
    expect(stripes[2]!.from).toBeCloseTo(0.5);
    for (const s of stripes) expect(s.from + s.width).toBeLessThanOrEqual(1);
    expect(minuteMarks(v)).toEqual([5]);
    expect(minuteMarks({ startedAt: 0, endedAt: 2 * 3_600_000 })).toEqual([30, 60, 90]);
  });

  it('says lengths and times the way people read them', () => {
    expect(clockOf(0, 3_725_000)).toBe('1:02:05');
    expect(lengthOf({ startedAt: 0, endedAt: 72 * 60_000 })).toBe('1 h 12 min');
    expect(lengthOf({ startedAt: 0, endedAt: 20_000 })).toBe('under a minute');
    expect(wordCount(lines)).toBe(15);
  });
});
