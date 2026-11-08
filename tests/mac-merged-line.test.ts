import { describe, expect, it } from 'vitest';
import { isMergedItem, withoutDoubleMerge } from '../packages/mac/src/chat/merged-model.js';
import { type LogItem, mergedText } from '../src/core/store.js';

const line = (id: string, more: Partial<Extract<LogItem, { type: 'system' }>> = {}): LogItem => ({ id, type: 'system', channel: 'ws:w1', text: id, ts: 1, level: 'info', ...more });
const merged = (id: string, number?: number) => line(id, { merged: { into: 'main', ...(number !== undefined ? { number } : {}) } });
const shipped = (id: string, number: number) => line(id, { shipped: { number, into: 'main' } });

describe('the merged line', () => {
  it('says what merged where, with its PR when there was one', () => {
    expect(mergedText({ into: 'main', number: 12 })).toBe('Above this line was merged into main in PR #12.');
    expect(mergedText({ into: 'the main folder' })).toBe('Above this line was merged into the main folder.');
    expect(isMergedItem(merged('m', 1))).toBe(true);
    expect(isMergedItem(shipped('s', 1))).toBe(false);
  });

  it('gives way to Continue After Merge’s divider for the same PR right after it', () => {
    expect(withoutDoubleMerge([merged('m', 4), shipped('s', 4)]).map((l) => l.id)).toEqual(['s']);
    // Something said between them, another PR, or a merge without one: both stay.
    expect(withoutDoubleMerge([merged('m', 4), line('x'), shipped('s', 4)]).map((l) => l.id)).toEqual(['m', 'x', 's']);
    expect(withoutDoubleMerge([merged('m', 3), shipped('s', 4)]).map((l) => l.id)).toEqual(['m', 's']);
    expect(withoutDoubleMerge([merged('m'), shipped('s', 4)]).map((l) => l.id)).toEqual(['m', 's']);
    const same = [line('a'), merged('m', 4)];
    expect(withoutDoubleMerge(same)).toBe(same);
  });
});
