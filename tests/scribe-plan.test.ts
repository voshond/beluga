import { describe, expect, it } from 'vitest';
import { BATCH_SECONDS, LONGEST_WAIT_MS, batchOf, pickScribe, writeNow } from '../src/shared/scribe-plan.js';

const s = (by: string, o: Partial<{ ready: boolean; speed: number; backlog: number; cpu: number; battery: boolean }> = {}) => ({ by, ready: true, backlog: 0, ...o });

describe('who writes down whose words (BLG-718)', () => {
  it('your own Mac, when it can: no sound leaves it', () => {
    expect(pickScribe('ann', [s('ann', { speed: 6 }), s('bo', { speed: 9 })], 5)).toBe('ann');
  });

  it('someone else when you have no model, are busy, behind, or on battery while they aren’t', () => {
    expect(pickScribe('ann', [s('ann', { ready: false }), s('bo')], 5)).toBe('bo');
    expect(pickScribe('ann', [s('ann', { speed: 4, cpu: 1.4 }), s('bo', { speed: 4 })], 5)).toBe('bo');
    expect(pickScribe('ann', [s('ann', { speed: 4, backlog: 60 }), s('bo', { speed: 4 })], 5)).toBe('bo');
    expect(pickScribe('ann', [s('ann', { speed: 3, battery: true }), s('bo', { speed: 6 })], 5)).toBe('bo');
  });

  it('nobody with a model: no notes; everyone decides alike', () => {
    expect(pickScribe('ann', [s('ann', { ready: false }), s('bo', { ready: false })], 5)).toBeUndefined();
    const all = [s('ann', { ready: false }), s('cy', { speed: 5 }), s('bo', { speed: 5 })];
    expect(pickScribe('ann', all, 5)).toBe(pickScribe('ann', [...all].reverse(), 5));
  });
});

describe('when to write down (BLG-718)', () => {
  it('at once with time to spare; a stretch at a time when busy; never left behind for long', () => {
    expect(writeNow({ cpu: 0.2 }, 3, 0)).toBe(true);
    expect(writeNow({ cpu: 0.95 }, 10, 5_000)).toBe(false);
    expect(writeNow({ cpu: 0.95 }, BATCH_SECONDS, 5_000)).toBe(true);
    expect(writeNow({ cpu: 0.95 }, 4, LONGEST_WAIT_MS)).toBe(true);
    expect(writeNow({ battery: true }, 4, 1_000)).toBe(false);
    expect(writeNow({ cpu: 0.2 }, 0, 0)).toBe(false);
  });

  it('a stretch fits what the model reads in one go, one phrase at least', () => {
    const q = [{ seconds: 12 }, { seconds: 10 }, { seconds: 9 }, { seconds: 3 }];
    expect(batchOf(q, false)).toHaveLength(2);
    expect(batchOf([{ seconds: 40 }], false)).toHaveLength(1);
    expect(batchOf(q, true)).toHaveLength(1);
  });
});

describe('what Macs tell each other about writing down (BLG-718)', () => {
  it('statuses, phrase parts and words back are checked as they arrive', async () => {
    const { parseStage, CLIP_PART } = await import('../src/shared/calls.js');
    expect(parseStage('{"k":"scribe","by":"a","ready":true,"backlog":4,"speed":5.5,"cpu":0.3}')).toEqual({ k: 'scribe', by: 'a', ready: true, backlog: 4, speed: 5.5, cpu: 0.3 });
    expect(parseStage('{"k":"clip","by":"a","id":"p1","part":0,"parts":2,"seconds":6,"b64":"UklGRg=="}')).toMatchObject({ k: 'clip', parts: 2 });
    // Not base64, too big, or out of range: dropped.
    expect(parseStage('{"k":"clip","by":"a","id":"p1","part":0,"parts":2,"seconds":6,"b64":"<script>"}')).toBeUndefined();
    expect(parseStage(JSON.stringify({ k: 'clip', by: 'a', id: 'p1', part: 0, parts: 1, seconds: 6, b64: 'A'.repeat(CLIP_PART + 4) }))).toBeUndefined();
    expect(parseStage('{"k":"clip","by":"a","id":"p1","part":3,"parts":2,"seconds":6,"b64":"AA=="}')).toBeUndefined();
    expect(parseStage('{"k":"clip-text","by":"a","id":"p1","text":"ship it"}')).toEqual({ k: 'clip-text', by: 'a', id: 'p1', text: 'ship it' });
  });
});
