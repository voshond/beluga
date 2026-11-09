import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerWork } from '../packages/companion/lib/link/computer-work.js';
import { COMPANION_PROTO, type PhoneFrame, type WorkView } from '../src/companion/protocol.js';

/**
 * What the phone shows of each computer (BLG-810): topics subscribed on that computer's own link,
 * its views kept under its id (so `work` on the Mac and on the Mac mini are two, and an offline
 * one's still open), and calls answered by that computer, never queued for it.
 */

const MINI = 'a'.repeat(16);
const AWS = 'b'.repeat(16);
const work: WorkView = { projects: [{ id: 'p1', name: 'beluga', conversations: [] }] } as unknown as WorkView;

function make(opts: { open?: Set<string>; kept?: Record<string, { data: unknown; rev: number; at: number }> } = {}) {
  const open = opts.open ?? new Set([MINI, AWS]);
  const sent: Array<{ id: string; frame: PhoneFrame }> = [];
  const emitted: string[] = [];
  let saved: Record<string, { data: unknown; rev: number; at: number }> | undefined;
  const w = new ComputerWork({
    send: (id, frame) => {
      if (!open.has(id)) return false;
      sent.push({ id, frame });
      return true;
    },
    proto: (id) => (id === MINI ? { ...COMPANION_PROTO } : id === AWS ? { major: 1, minor: 20 } : undefined),
    name: (id) => (id === MINI ? 'Mac mini' : id === AWS ? 'aws' : undefined),
    emit: (key) => emitted.push(key),
    load: () => opts.kept,
    save: (k) => (saved = k),
    now: () => 1_000,
    timeoutMs: 5_000,
  });
  return { w, sent, emitted, open, saved: () => saved };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('each computer’s work on the phone', () => {
  it('subscribes what is on screen on that computer’s own link, and again when it opens', () => {
    const { w, sent } = make();
    const off = w.watch(MINI, 'work');
    w.watch(MINI, 'home');
    expect(sent.at(-1)).toEqual({ id: MINI, frame: { t: 'sub', topics: ['work', 'home'] } });
    expect(sent.every((s) => s.id === MINI)).toBe(true);
    off();
    expect(sent.at(-1)).toEqual({ id: MINI, frame: { t: 'sub', topics: ['home'] } });
    expect(w.topics(MINI)).toEqual(['home']);
    w.opened(MINI);
    expect(sent.at(-1)).toEqual({ id: MINI, frame: { t: 'sub', topics: ['home'] } });
  });

  it('keeps each computer’s views apart, under its id, and kept for when it’s offline', () => {
    vi.useFakeTimers();
    const { w, emitted, saved } = make();
    expect(w.take(MINI, { t: 'view', topic: 'work', rev: 1, data: work })).toBe(true);
    expect(emitted).toEqual([`view:${MINI}|work`]);
    expect(w.view<WorkView>(MINI, 'work')).toMatchObject({ rev: 1, stale: false, data: { projects: [{ name: 'beluga' }] } });
    expect(w.view(AWS, 'work')).toBeUndefined();
    // A view that doesn't match the protocol is dropped, not shown.
    expect(w.take(MINI, { t: 'view', topic: 'work', rev: 2, data: { nope: true } })).toBe(true);
    expect(w.view(MINI, 'work')?.rev).toBe(1);
    vi.advanceTimersByTime(1_000);
    const kept = saved();
    expect(Object.keys(kept ?? {})).toEqual([`${MINI}|work`]);

    // The next launch starts from what was kept, marked as not from that computer yet.
    const again = make({ kept });
    expect(again.w.view(MINI, 'work')).toMatchObject({ rev: 1, stale: true });
    again.w.forget(MINI);
    expect(again.w.view(MINI, 'work')).toBeUndefined();
  });

  it('calls on that computer and takes only its own answers', async () => {
    const { w, sent } = make();
    const answer = w.call(MINI, 'host.answerApproval', ['yes', 'a1']);
    const asked = sent.at(-1)!;
    expect(asked).toMatchObject({ id: MINI, frame: { t: 'call', method: 'host.answerApproval', args: ['yes', 'a1'] } });
    const n = (asked.frame as Extract<PhoneFrame, { t: 'call' }>).id;
    // The same id from another computer isn't this call's answer.
    expect(w.take(AWS, { t: 'result', id: n, ok: true, value: 'wrong' })).toBe(false);
    expect(w.take(MINI, { t: 'result', id: n, ok: true, value: 'done' })).toBe(true);
    await expect(answer).resolves.toBe('done');

    const refused = w.call(MINI, 'session.setPrefs', []);
    const m = (sent.at(-1)!.frame as Extract<PhoneFrame, { t: 'call' }>).id;
    w.take(MINI, { t: 'result', id: m, ok: false, error: 'session.setPrefs is only on your Mac' });
    await expect(refused).rejects.toThrow(/only on your Mac/);
  });

  it('never queues for a computer that’s away, and says when one went away mid-call', async () => {
    const { w, open } = make();
    open.delete(AWS);
    await expect(w.call(AWS, 'companion.ask', [])).rejects.toThrow('aws is away.');
    const inFlight = w.call(MINI, 'companion.ask', []);
    w.closed(MINI);
    await expect(inFlight).rejects.toMatchObject({ message: 'Mac mini went away.', lost: true });
  });

  it('reads what each computer has from its own protocol', () => {
    const { w } = make();
    expect(w.supports(MINI, 'computers')).toBe(true);
    expect(w.supports(AWS, 'sentinel')).toBe(false);
    expect(w.supports(AWS, 'tasks')).toBe(true);
    expect(w.supports('c'.repeat(16), 'tasks')).toBe(false);
  });
});
