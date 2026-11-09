import { describe, expect, it } from 'vitest';
import { OnceEach, machineNotice, noticeKey, sumCounts, tagFor, untag } from '../src/machines/attention.js';

/**
 * One bell for every computer (BLG-790): a computer's notice shown once, with its name, what it's
 * about tagged with the computer so opening or answering it acts there, and every computer's
 * counts added to this Mac's.
 */

const AWS = 'de30a1c0ffee0002';

describe('a computer’s notice through this app', () => {
  it('says which computer, and tags what it’s about with it', () => {
    const shown = machineNotice({ id: AWS, name: 'build-box' }, { title: 'Claude asks', body: 'Run the migration?', sound: true, channel: 'ws:w1', approval: 'a1' });
    expect(shown.title).toBe('build-box · Claude asks');
    expect(shown.body).toBe('Run the migration?');
    expect(untag(shown.channel)).toEqual({ machine: AWS, id: 'ws:w1' });
    expect(untag(shown.approval)).toEqual({ machine: AWS, id: 'a1' });
    expect(shown.task).toBeUndefined();
  });

  it('this Mac’s own ids stay as they are', () => {
    expect(untag('ws:w1')).toEqual({ id: 'ws:w1' });
    expect(untag(undefined)).toEqual({});
    expect(untag(tagFor(AWS, 'm:odd:id'))).toEqual({ machine: AWS, id: 'm:odd:id' });
  });

  it('notifies once per item, however many times it comes, and again once it’s old', () => {
    const once = new OnceEach(60_000);
    const raw = { title: 'Claude asks', body: 'Run it?', sound: true, approval: 'a1' };
    expect(once.first(noticeKey(AWS, raw), 0)).toBe(true);
    expect(once.first(noticeKey(AWS, raw), 1_000)).toBe(false);
    // The same words from another computer are another item.
    expect(once.first(noticeKey('0123456789abcdef', raw), 1_000)).toBe(true);
    expect(once.first(noticeKey(AWS, raw), 61_001)).toBe(true);
  });

  it('forgets the oldest past its limit', () => {
    const once = new OnceEach(60_000, 2);
    once.first('a', 0);
    once.first('b', 0);
    once.first('c', 0);
    expect(once.first('a', 1)).toBe(true);
    expect(once.first('c', 1)).toBe(false);
  });
});

describe('the bell and the Dock count every computer', () => {
  it('adds each computer’s to this Mac’s', () => {
    expect(sumCounts({ new: 2, waiting: 1, working: 0 }, [{ new: 3, waiting: 2, working: 1 }, { new: 0, waiting: 1, working: 2 }])).toEqual({ new: 5, waiting: 4, working: 3 });
    expect(sumCounts({ new: 2, waiting: 1, working: 0 }, [])).toEqual({ new: 2, waiting: 1, working: 0 });
  });
});
