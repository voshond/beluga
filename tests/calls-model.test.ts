import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_INK, applyInk, hasInk, sketchBox, strokeAlpha, tidyInk } from '../packages/mac/src/call/ink.js';
import { JOINED, LEFT, RING, RINGBACK, RINGBACK_EVERY_S, RING_EVERY_S } from '../packages/mac/src/call/ringtone.js';
import { MissedCalls } from '../src/core/calls/missed.js';
import { render } from '../packages/mac/src/lib/sounds/synth.js';
import { needsYou } from '../src/companion/needs-you.js';
import { NeedsYou } from '../src/companion/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import { callLength, keeps, missedCallText, parseStage, shareChildren, shareTree, shareTreeBy, sharerOf } from '../src/shared/calls.js';

describe('the share tree (BLG-706)', () => {
  it('the sharer feeds three viewers; each viewer passes it on to at most two', () => {
    const viewers = Array.from({ length: 15 }, (_, i) => `v${i}`);
    const tree = shareTree('s', viewers);
    expect(shareChildren(tree, 's')).toEqual(['v0', 'v1', 'v2']);
    expect(shareChildren(tree, 'v0')).toEqual(['v3', 'v4']);
    expect(shareChildren(tree, 'v1')).toEqual(['v5', 'v6']);
    for (const v of viewers) expect(shareChildren(tree, v).length).toBeLessThanOrEqual(2);
    // Everyone is reached, and nobody feeds themselves or someone who feeds them.
    expect(tree.size).toBe(15);
    for (const [to, from] of tree) {
      expect(from).not.toBe(to);
      expect(viewers.indexOf(from)).toBeLessThan(viewers.indexOf(to));
    }
  });

  it('small calls are a plain star', () => {
    const tree = shareTree('s', ['a', 'b']);
    expect([...tree.values()]).toEqual(['s', 's']);
  });
});

describe('call helpers', () => {
  it('both Macs keep the same of two calls', () => {
    expect(keeps('0aa', '0ab')).toBe('0aa');
    expect(keeps('0ab', '0aa')).toBe('0aa');
  });

  it('the last to start sharing has the stage', () => {
    const p = (peerId: string, sharing: boolean, joinedAt: number) => ({ peerId, name: peerId, muted: false, sharing, joinedAt });
    expect(sharerOf({ people: [p('a', true, 1), p('b', true, 2)] })?.peerId).toBe('b');
    expect(sharerOf({ people: [p('a', false, 1)] })).toBeUndefined();
  });

  it('says how long a call has gone', () => {
    expect(callLength(65_000)).toBe('1:05');
    expect(callLength(3_729_000)).toBe('1:02:09');
  });

  it('checks what other windows send on the stage', () => {
    expect(parseStage('{"k":"laser","by":"a","x":0.5,"y":0.25}')).toEqual({ k: 'laser', by: 'a', x: 0.5, y: 0.25 });
    expect(parseStage('{"k":"ink","by":"a","id":"s1","color":"#a3c9f7","pts":[0.1,0.2,0.3,0.4],"done":true}')).toMatchObject({ k: 'ink', done: true });
    expect(parseStage('{"k":"ink","by":"a","id":"s1","color":"red","pts":[]}')).toBeUndefined();
    expect(parseStage('{"k":"laser","by":"a","x":"no","y":1}')).toBeUndefined();
    expect(parseStage('not json')).toBeUndefined();
    expect(parseStage('{"k":"asked","by":"a","ask":"m1","box":[0,0,0.5,0.5]}')).toEqual({ k: 'asked', by: 'a', ask: 'm1', box: [0, 0, 0.5, 0.5] });
  });
});

describe('a call ringing for you reaches the phone (BLG-706)', () => {
  it('is a Needs you card: Answer on Mac, or Decline; gone once it stops ringing', () => {
    const s = new Store(initialState('room'));
    const conversation = `group:${'a'.repeat(32)}`;
    const bob = { peerId: 'b'.repeat(32), name: 'bob', muted: false, sharing: false, joinedAt: 1 };
    s.dispatch({ type: 'net_calls', calls: { [conversation]: { id: '0123456789abcdef', conversation, startedBy: bob.peerId, startedAt: 1, people: [bob], mine: 'ringing', ringBy: bob.peerId, ringSince: 5 } } });
    const card = needsYou(s.getState()).find((n) => n.kind === 'call');
    expect(card).toMatchObject({ id: 'call:0123456789abcdef', title: 'bob is calling', from: 'bob' });
    expect(card?.actions.map((a) => [a.label, a.method, a.args])).toEqual([
      ['Answer on Mac', 'calls.join', [conversation]],
      ['Decline', 'calls.decline', [conversation]],
    ]);
    // What the phone is sent is checked by its own schema.
    expect(NeedsYou.safeParse(card).success).toBe(true);
    s.dispatch({ type: 'net_calls', calls: {} });
    expect(needsYou(s.getState()).some((n) => n.kind === 'call')).toBe(false);
    expect(s.getState().network.calls).toBeUndefined();
  });
});

describe('drawing on a shared screen is sketching (BLG-717)', () => {
  const stroke = (by: string, id: string, done = true) => ({ k: 'ink' as const, by, id, color: '#a3c9f7', pts: [0.1, 0.1, 0.2, 0.2], ...(done ? { done: true } : {}) });

  it('strokes a moment apart are one sketch; drawing again after a pause clears the old one', () => {
    let ink = applyInk(NO_INK, stroke('a', 's1'), 0);
    ink = applyInk(ink, stroke('a', 's2'), 1_500); // writing a word: kept together
    expect(ink.strokes.map((s) => s.id)).toEqual(['s1', 's2']);
    ink = applyInk(ink, stroke('b', 't1'), 1_600); // someone else's never clears yours
    ink = applyInk(ink, stroke('a', 's3'), 6_000); // a pause, then a new sketch
    expect(ink.strokes.map((s) => s.id)).toEqual(['t1', 's3']);
  });

  it('a sketch stays while it’s fresh and fades by itself, all together', () => {
    let ink = applyInk(NO_INK, stroke('a', 's1'), 0);
    ink = applyInk(ink, stroke('a', 's2'), 2_000);
    // Whole a few seconds after the last stroke (the first is older, and stays with it), then dissolving, then gone.
    expect(strokeAlpha(ink.strokes[0]!, 2_000 + 3_000, ink.strokes)).toBe(1);
    const fading = strokeAlpha(ink.strokes[0]!, 2_000 + 4_000, ink.strokes);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    expect(hasInk(tidyInk(ink, 2_000 + 5_000))).toBe(false);
    // Its Mac left mid-stroke: no end comes, and it still goes.
    const stuck = applyInk(NO_INK, stroke('b', 'x', false), 0);
    expect(hasInk(tidyInk(tidyInk(stuck, 9_000), 9_000 + 9_000))).toBe(false);
  });

  it('Ask covers the sketch, with a little room; Clear takes it all', () => {
    const ink = applyInk(NO_INK, { k: 'ink', by: 'a', id: 's', color: '#a3c9f7', pts: [0.2, 0.3, 0.5, 0.6], done: true }, 0);
    const [x, y, w, h] = sketchBox(ink.strokes, 'a')!;
    expect(x).toBeCloseTo(0.16);
    expect(y).toBeCloseTo(0.26);
    expect(w).toBeCloseTo(0.38);
    expect(h).toBeCloseTo(0.38);
    expect(sketchBox(ink.strokes, 'b')).toBeUndefined();
    const lit = applyInk(ink, { k: 'laser', by: 'c', x: 0.5, y: 0.5 }, 0);
    expect(Object.keys(tidyInk(lit, 1_000).lasers)).toEqual(['c']);
    expect(applyInk(lit, { k: 'clear', by: 'a' }, 0).strokes).toEqual([]);
  });
});

describe('calls of 5–10 people (BLG-717)', () => {
  it('the share relays through the best uploads, each feeding as many as it can carry', () => {
    const v = (peerId: string, uplink: number | undefined, joinedAt: number) => ({ peerId, ...(uplink !== undefined ? { uplink } : {}), joinedAt });
    // The sharer can carry two; ann has a great line, bo a weak one (watches only).
    const tree = shareTreeBy({ peerId: 's', uplink: 7_000 }, [v('bo', 900, 1), v('ann', 20_000, 2), v('cy', 8_000, 3), v('di', 5_000, 4), v('ed', 3_000, 5), v('fi', 3_000, 6), v('gu', undefined, 7)]);
    expect(shareChildren(tree, 's')).toEqual(['ann', 'cy']);
    expect(shareChildren(tree, 'ann')).toEqual(['di', 'ed', 'fi', 'bo', 'gu']);
    expect(shareChildren(tree, 'bo')).toEqual([]);
    expect(tree.size).toBe(7);
    // Every Mac draws the same tree: it only depends on what everyone said.
    expect([...shareTreeBy({ peerId: 's', uplink: 7_000 }, [v('cy', 8_000, 3), v('ann', 20_000, 2), v('bo', 900, 1), v('gu', undefined, 7), v('fi', 3_000, 6), v('ed', 3_000, 5), v('di', 5_000, 4)])]).toEqual([...tree]);
  });

  it('a camera goes as big as its viewer shows it, within the upload it gets; nothing when unseen', async () => {
    const { cameraEncoding } = await import('../packages/mac/src/call/camera-size.js');
    expect(cameraEncoding('big')).toMatchObject({ maxBitrate: 1_800_000, scaleResolutionDownBy: 1, active: true });
    expect(cameraEncoding('big', 500)).toMatchObject({ maxBitrate: 500_000, scaleResolutionDownBy: 2 });
    expect(cameraEncoding('small')).toMatchObject({ maxBitrate: 350_000, scaleResolutionDownBy: 2 });
    expect(cameraEncoding('none').active).toBe(false);
  });
});

describe('the ringtone (BLG-706)', () => {
  it('is continuous (no gap, the next turn picks up where this one ends) yet rings in clear beats; nothing clips', () => {
    const rate = 22_050;
    const turn = render(RING, 0.8, rate);
    const step = Math.round(RING_EVERY_S * rate);
    // Two turns laid end to end, as the player schedules them; measured over the second, seam included.
    const two = new Float32Array(step + turn.length);
    for (const at of [0, step]) turn.forEach((v, i) => (two[at + i]! += v));
    const win = Math.round(rate / 20);
    const levels: number[] = [];
    for (let at = step; at + win < step * 2; at += win) {
      let sum = 0;
      for (let i = at; i < at + win; i++) sum += two[i]! ** 2;
      levels.push(Math.sqrt(sum / win));
    }
    const loud = Math.max(...levels);
    expect(Math.min(...levels)).toBeGreaterThan(loud * 0.2);
    // Eight rings a turn (two on each of the four chords) stand out over the held chords.
    const beats = levels.map((v) => (v > loud * 0.7 ? '#' : '.')).join('').match(/#+/g) ?? [];
    expect(beats.length).toBeGreaterThanOrEqual(8);
    expect(two.every((v) => Math.abs(v) < 1)).toBe(true);
  });

  it('the caller hears ring-ring, then quiet: four times a turn, never a held tone', () => {
    const rate = 22_050;
    const turn = render(RINGBACK, 0.7, rate);
    const step = Math.round(RINGBACK_EVERY_S * rate);
    const win = Math.round(rate / 40);
    const levels: number[] = [];
    for (let at = 0; at + win < step; at += win) {
      let sum = 0;
      for (let i = at; i < at + win; i++) sum += (turn[i] ?? 0) ** 2;
      levels.push(Math.sqrt(sum / win));
    }
    const loud = Math.max(...levels);
    // Loud stretches (each ring of a pair) and quiet ones between the pairs.
    const shape = levels.map((v) => (v > loud * 0.35 ? '#' : v < loud * 0.08 ? '_' : '.')).join('');
    const quiets = shape.match(/_{8,}/g) ?? [];
    expect(quiets.length).toBeGreaterThanOrEqual(3);
    expect(shape.match(/#+/g)?.length).toBeGreaterThanOrEqual(8);
    expect(turn.every((v) => Math.abs(v) < 1)).toBe(true);
  });

  it('joining rises and leaving falls, both short', () => {
    const pitch = (spec: typeof JOINED): number[] => spec.notes.map((n) => n.freq);
    const up = pitch(JOINED);
    const down = pitch(LEFT);
    expect(up.every((f, i) => i === 0 || f > up[i - 1]!)).toBe(true);
    expect(down.every((f, i) => i === 0 || f < down[i - 1]!)).toBe(true);
    expect(Math.max(JOINED.maxLength, LEFT.maxLength)).toBeLessThan(1);
  });
});

describe('agents look call notes up instead of reading them in the prompt (BLG-715)', () => {
  const view = (id: string, conversation: string, lines: Array<[string, number, string]>) => ({
    id,
    conversation,
    startedAt: 0,
    endedAt: 600_000,
    people: [
      { peerId: 'bo', name: 'bo', sent: true },
      { peerId: 'me', name: 'You', sent: true },
    ],
    lines: lines.map(([by, s, text]) => ({ by, name: by === 'me' ? 'You' : by, at: s * 1000, text })),
  });
  const src = {
    views: () => ({
      'group:a': [view('aaaa000000000001', 'group:a', [['bo', 5, 'Ship it today'], ['me', 9, 'After the tax fix'], ['bo', 400, 'Refunds are fine by me']])],
      'dm:x': [view('bbbb000000000002', 'dm:x', [['bo', 3, 'A secret plan for refunds']])],
    }),
    placeOf: (c: string) => (c === 'group:a' ? '#launch' : 'a DM with bo'),
  };

  it('a prompt only says calls exist and how to look; never what was said', async () => {
    const { userPrompt } = await import('../src/core/chat/claude-prompt.js');
    const { notesHint } = await import('../src/core/calls/notes-tools.js');
    const ask = { id: 'm1', conversation: 'group:a', from: 'a', name: 'ann', text: 'what did we decide?', ts: 1, mine: true } as const;
    const hint = notesHint(src, 'group:a')!;
    const prompt = userPrompt({ history: [], ask, asker: 'ann', files: [], since: [], notesHint: hint });
    expect(prompt).toContain('call_notes_search');
    expect(prompt).not.toContain('Ship it today');
    expect(notesHint(src, 'group:none')).toBeUndefined();
  });

  it('list, search and read a page; a chat’s tools reach only its own calls', async () => {
    const { callNotesTools } = await import('../src/core/calls/notes-tools.js');
    const all = callNotesTools(src);
    expect(all.list()).toMatch(/aaaa000000000001 · #launch/);
    expect(all.search('refunds')).toMatch(/2 places match/);
    expect(all.search('refunds', 'aaaa')).toMatch(/call aaaa000000000001 at 6:40, bo: Refunds are fine by me/);
    expect(all.read('aaaa000000000001', { at: '6:30' })).toMatch(/\[6:40\] bo: Refunds/);
    expect(all.read('aaaa000000000001', { limit: 1 })).toMatch(/More: call_notes_read\(call: "aaaa000000000001", from: 1\)/);
    const chat = callNotesTools(src, 'group:a');
    expect(chat.search('secret')).toMatch(/Nothing said matches/);
    expect(() => chat.read('bbbb000000000002')).toThrow(/No call/);
  });
});

describe('calls you missed', () => {
  const at = new Date(2026, 10, 5, 14, 5).getTime();
  const one = { id: '0123456789abcdef', conversation: `dm:${'b'.repeat(32)}`, by: 'b'.repeat(32), name: 'Ann', at };

  it('say who tried calling you and when (and the day, when it wasn’t today)', () => {
    expect(missedCallText(one, at + 60_000)).toMatch(/^Ann tried calling you at \d{1,2}[:.]05/);
    expect(missedCallText(one, at + 60_000)).not.toMatch(/ on /);
    expect(missedCallText(one, at + 3 * 24 * 60 * 60_000)).toMatch(/ on /);
  });

  it('are kept on disk, once each, only for you, the latest of each conversation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'missed-'));
    const file = path.join(dir, 'missed-calls.json');
    try {
      let seen: Record<string, readonly unknown[]> = {};
      const store = new MissedCalls({ file, now: () => at, publish: (v) => (seen = v) });
      store.add(one);
      store.add(one);
      expect(seen[one.conversation]).toHaveLength(1);
      // Windows has no Unix modes: the user profile's own ACL keeps it private there.
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      for (let i = 0; i < 25; i++) store.add({ ...one, id: i.toString(16).padStart(16, '0'), at: at - 1000 + i });
      // After a restart they're still there.
      const again = new MissedCalls({ file, now: () => at, publish: () => undefined });
      const kept = again.views()[one.conversation]!;
      expect(kept).toHaveLength(20);
      expect(kept.at(-1)).toEqual(one);
      // A month later they're gone.
      expect(new MissedCalls({ file, now: () => at + 31 * 24 * 60 * 60_000, publish: () => undefined }).views()).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reach the screens through the shared state, and outlast the network going off', () => {
    const s = new Store(initialState('room'));
    s.dispatch({ type: 'net_missed_calls', missed: { [one.conversation]: [one] } });
    expect(s.getState().network.missedCalls?.[one.conversation]).toEqual([one]);
    s.dispatch({ type: 'net_off' });
    expect(s.getState().network.missedCalls?.[one.conversation]).toEqual([one]);
  });
});
