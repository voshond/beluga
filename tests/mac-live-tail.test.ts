import { describe, expect, it } from 'vitest';
import type { LogItem, SubAgent } from '../src/core/store.js';
import type { StepSummary } from '../src/shared/steps.js';
import { READS_AFTER_STEP, STEERED_IN, STOPPING_FOR, TAKEN_BACK, steeredMessages } from '../src/shared/claude-notices.js';
import { Store, initialState } from '../src/core/store.js';
import { inHead, isLiveTurn, subInHead, withLiveTails, wordsOf, workingPhase } from '../packages/mac/src/chat/live-tail.js';
import { marksOf } from '../src/core/store.js';

/** A turn you spoke during goes on below what you said; once it ends it stays where it was drawn (BLG-22). */

type Agent = Extract<LogItem, { type: 'agent' }>;
const chat = (id: string, ts: number): LogItem => ({ id, type: 'chat', channel: 'ws:1', from: 'me', name: 'me', text: id, ts, byAgent: false });
const turn = (id: string, ts: number, more: Partial<Agent> = {}): Agent => ({
  id,
  type: 'agent',
  channel: 'ws:1',
  requestId: id,
  owner: 'me',
  ownerName: 'me',
  requesterName: 'me',
  status: 'tool',
  text: '',
  steps: [],
  subagents: [],
  ts,
  ...more,
});
/** The chat's order: row ids, a split turn's parts marked. */
const order = (rows: readonly LogItem[]) => withLiveTails(rows).map((x) => (x.part ? `${x.row.id}:${x.part.side}` : x.row.id));

describe('withLiveTails', () => {
  it('leaves a turn nobody spoke during whole', () => {
    expect(order([chat('ask', 1), turn('c', 2)])).toEqual(['ask', 'c']);
    expect(order([chat('ask', 1), turn('c', 2, { status: 'done', text: 'ok', endTs: 9 }), chat('next', 10)])).toEqual(['ask', 'c', 'next']);
  });

  it('draws a running turn’s live part below messages sent during it, its head where it began', () => {
    expect(order([chat('ask', 1), turn('c', 2), chat('steer 1', 5), chat('steer 2', 7)])).toEqual(['ask', 'c:head', 'steer 1', 'steer 2', 'c:tail']);
  });

  it('cuts at the first message said during the turn', () => {
    const shown = withLiveTails([chat('ask', 1), turn('c', 2), chat('steer', 5), chat('again', 7)]);
    expect(shown.filter((x) => x.part).map((x) => x.part)).toEqual([
      { side: 'head', cut: 5 },
      { side: 'tail', cut: 5 },
    ]);
    // The two parts are rows of their own (the list keys them apart).
    expect(new Set(shown.map((x) => x.key)).size).toBe(shown.length);
  });

  it('counts notes about steered and queued messages as said during the turn, the live part still last', () => {
    const rows = [chat('ask', 1), turn('c', 2), chat('steer', 5), turn('s', 5, { status: 'text', text: READS_AFTER_STEP }), chat('later', 6), turn('q', 6, { status: 'queued' })];
    expect(order(rows)).toEqual(['ask', 'c:head', 'steer', 's', 'later', 'q', 'c:tail']);
  });

  it('keeps a finished turn where it was drawn: its tail after what was said during it, before what came after', () => {
    const rows = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'answer', endTs: 20 }), chat('steer', 5), turn('s', 5, { status: 'done', text: STEERED_IN }), chat('thanks', 30)];
    expect(order(rows)).toEqual(['ask', 'c:head', 'steer', 's', 'c:tail', 'thanks']);
  });

  it('when the turn ends, its parts don’t move: the same order running and answered', () => {
    const during = [chat('ask', 1), turn('c', 2), chat('steer', 5)];
    const after = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'answer', endTs: 20 }), chat('steer', 5)];
    expect(order(after)).toEqual(order(during));
  });

  it('a queued message’s own turn comes after the finished turn’s tail', () => {
    const rows = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'answer', endTs: 20 }), chat('next', 5), turn('d', 5, { status: 'tool' })];
    expect(order(rows)).toEqual(['ask', 'c:head', 'next', 'c:tail', 'd']);
  });

  it('leaves a finished turn without an end time whole (saved before it was kept)', () => {
    expect(order([turn('c', 2, { status: 'done', text: 'answer' }), chat('later', 5)])).toEqual(['c', 'later']);
  });

  it('two Claudes at work: each live part goes to the end, in order', () => {
    const rows = [turn('mine', 1), chat('hey', 3), turn('bobs', 4, { owner: 'bob' }), chat('more', 5)];
    expect(order(rows)).toEqual(['mine:head', 'hey', 'bobs:head', 'more', 'mine:tail', 'bobs:tail']);
  });
});

describe('one working line per Claude, always its last row (BLG-54)', () => {
  const sub = (id: string, status: SubAgent['status'], kind: SubAgent['kind'] = 'background'): SubAgent => ({ id, title: id, steps: [], status, kind });
  /** The chat's order, a split turn's parts marked, `*` on the row with the working line. */
  const drawn = (rows: readonly LogItem[]) => withLiveTails(rows).map((x) => `${x.part ? `${x.row.id}:${x.part.side}` : x.row.id}${x.working ? `*${x.working.id}` : ''}`);
  const workingLines = (rows: readonly LogItem[]) => withLiveTails(rows).filter((x) => x.working).length;

  it('a running turn its own steered message took over: no working line of its own, drawn as if it ended there', () => {
    // The screenshot: c (still "Thinking") above your message, then your message's turn d at work.
    const rows = [chat('ask', 1), turn('c', 2, { between: 'thinking' }), chat('steer', 5), turn('d', 6)];
    expect(drawn(rows)).toEqual(['ask', 'c:head', 'steer', 'c:tail', 'd*d']);
    expect(workingLines(rows)).toBe(1);
  });

  it('what a taken-over turn left running (background jobs, sub-agents) goes to the very bottom, with the one working line', () => {
    const rows = [chat('ask', 1), turn('c', 2, { text: 'Started the jobs', subagents: [sub('npm run build', 'running'), sub('done one', 'done')] }), chat('also', 5), turn('d', 6)];
    const shown = withLiveTails(rows);
    expect(drawn(rows)).toEqual(['ask', 'c:head', 'also', 'c:tail', 'd', 'c:live*d']);
    // Its running work is drawn there, the rest where it started.
    expect(shown.find((x) => x.key === 'c:tail')?.subs).toBe('settled');
    expect(shown.find((x) => x.key === 'c:live')?.subs).toBe('running');
    // d answered: the working line says what still runs (c's background job), still last.
    const after = [...rows.slice(0, 3), turn('d', 6, { status: 'done', text: 'ok', endTs: 9 })];
    expect(drawn(after)).toEqual(['ask', 'c:head', 'also', 'c:tail', 'd', 'c:live*c']);
    expect(withLiveTails(after).at(-1)?.working?.id).toBe('c');
  });

  it('taken over by your message’s own turn (its card from the same moment): nothing moves when the interrupted turn ends', () => {
    const running = [chat('ask', 1), turn('c', 2, { text: 'Interrupted to read your message' }), chat('steer', 5), turn('d', 5)];
    const ended = [chat('ask', 1), turn('c', 2, { status: 'done', text: 'Interrupted to read your message', endTs: 9 }), chat('steer', 5), turn('d', 5)];
    expect(drawn(running)).toEqual(['ask', 'c:head', 'steer', 'c:tail', 'd*d']);
    expect(drawn(ended)).toEqual(['ask', 'c:head', 'steer', 'c:tail', 'd*d']);
  });

  it('never two working lines for one Claude, however many of its cards still say they run', () => {
    const rows = [turn('a', 1, { between: 'thinking' }), chat('x', 2), turn('b', 3), chat('y', 4), turn('c', 5, { between: 'writing', text: 'So far' })];
    expect(workingLines(rows)).toBe(1);
    expect(withLiveTails(rows).at(-1)?.working?.id).toBe('c');
  });

  it('a steered message waiting to be read keeps the running turn at work: its live part, with the line, below the message', () => {
    const rows = [chat('ask', 1), turn('c', 2), chat('steer', 5), turn('s', 5, { status: 'started', text: READS_AFTER_STEP })];
    expect(drawn(rows)).toEqual(['ask', 'c:head', 'steer', 's', 'c:tail*c']);
    const stopping = [chat('ask', 1), turn('c', 2), chat('steer', 5), turn('s', 5, { status: 'started', text: STOPPING_FOR })];
    expect(drawn(stopping)).toEqual(['ask', 'c:head', 'steer', 's', 'c:tail*c']);
  });

  it('each Claude at work has its own line', () => {
    const rows = [turn('mine', 1), chat('hey', 3), turn('bobs', 4, { owner: 'bob' }), chat('more', 5)];
    expect(drawn(rows)).toEqual(['mine:head', 'hey', 'bobs:head', 'more', 'mine:tail*mine', 'bobs:tail*bobs']);
  });

  it('none when nobody works', () => {
    expect(workingLines([chat('ask', 1), turn('c', 2, { status: 'done', text: 'ok', endTs: 3 })])).toBe(0);
  });
});

describe('a steered message: sent, then read (BLG-54)', () => {
  const said = (id: string, ts: number, request: string): LogItem => ({ ...(chat(id, ts) as Extract<LogItem, { type: 'chat' }>), request });

  it('waits on the message until Claude reads it; the note card isn’t drawn', () => {
    const items = [chat('ask', 1), turn('c', 2), said('m', 5, 'r2'), turn('n', 5, { requestId: 'r2', status: 'started', text: READS_AFTER_STEP })];
    const { waiting, notes } = steeredMessages(items);
    expect(waiting.get('m')).toEqual({ request: 'r2', waiting: 'next_step' });
    expect([...notes]).toEqual(['n']);
    // Its step being stopped for it (Send now, a long step).
    expect(steeredMessages([items[2]!, turn('n', 5, { requestId: 'r2', status: 'started', text: STOPPING_FOR })]).waiting.get('m')?.waiting).toBe('stopping');
    // Read mid-turn: nothing waits; the note still isn't drawn.
    const read = steeredMessages([items[2]!, turn('n', 5, { requestId: 'r2', status: 'done', text: STEERED_IN })]);
    expect(read.waiting.size).toBe(0);
    expect([...read.notes]).toEqual(['n']);
    // Its own turn: nothing waits, and the card is a turn like any other.
    const own = steeredMessages([items[2]!, turn('n', 5, { requestId: 'r2', status: 'started', text: '' })]);
    expect(own.waiting.size).toBe(0);
    expect(own.notes.size).toBe(0);
  });

  it('sent to steer: not read from the moment it’s drawn, before its card comes', () => {
    const sent = { ...(said('m', 5, 'r2') as Extract<LogItem, { type: 'chat' }>), steer: true as const };
    expect(steeredMessages([sent]).waiting.get('m')).toEqual({ request: 'r2', waiting: 'next_step' });
    // It got a turn of its own at once (no run to steer after all): nothing waits.
    expect(steeredMessages([sent, turn('n', 5, { requestId: 'r2', status: 'started' })]).waiting.size).toBe(0);
  });

  it('taken back (Cancel): the message and its card are gone from the chat, and it isn’t a turn', () => {
    const gone = steeredMessages([chat('ask', 1), said('m', 5, 'r2'), turn('n', 5, { requestId: 'r2', status: 'error', text: TAKEN_BACK })]);
    expect(gone.waiting.size).toBe(0);
    expect([...gone.notes].sort()).toEqual(['m', 'n']);
    expect(isLiveTurn({ status: 'error', text: TAKEN_BACK })).toBe(false);
  });

  it('a message that doesn’t know its request keeps its note card', () => {
    expect(steeredMessages([chat('m', 5), turn('n', 5, { requestId: 'r2', status: 'started', text: READS_AFTER_STEP })]).notes.size).toBe(0);
  });

  it('the store: the note goes once its own turn starts, a newer note replaces it, Claude’s words follow', () => {
    const store = new Store(initialState('room', 'auto'));
    const ev = (event: 'text' | 'started', text = '') => store.dispatch({ type: 'agent_event', owner: 'me', requestId: 'r2', requester: 'me', event, text, ts: 1, channel: 'ws:1' });
    const card = () => store.getState().log.find((l) => l.type === 'agent' && l.requestId === 'r2') as Agent;
    ev('text', READS_AFTER_STEP);
    expect(card().text).toBe(READS_AFTER_STEP);
    ev('text', STOPPING_FOR);
    expect(card().text).toBe(STOPPING_FOR);
    ev('started');
    expect(card().text).toBe('');
    ev('text', 'Looking at the retries');
    expect(card().text).toBe('Looking at the retries');
  });
});

describe('isLiveTurn', () => {
  it('is a turn at work, not a queued message or a note about a steered one', () => {
    expect(isLiveTurn(turn('c', 1))).toBe(true);
    expect(isLiveTurn(turn('q', 1, { status: 'queued' }))).toBe(false);
    expect(isLiveTurn(turn('s', 1, { status: 'text', text: READS_AFTER_STEP }))).toBe(false);
    expect(isLiveTurn(turn('d', 1, { status: 'done', text: 'ok' }))).toBe(false);
  });
});

describe('inHead', () => {
  const step = (id: string, startedAt: number, more: Partial<StepSummary> = {}): StepSummary => ({ id, kind: 'tool', title: id, status: 'done', startedAt, ...more });

  it('keeps only steps that had finished before the cut', () => {
    expect(inHead(step('a', 1, { endedAt: 3 }), 5)).toBe(true);
    expect(inHead(step('b', 1, { durationMs: 2 }), 5)).toBe(true);
    expect(inHead(step('c', 4, { endedAt: 8 }), 5)).toBe(false);
    expect(inHead(step('d', 6, { endedAt: 7 }), 5)).toBe(false);
  });

  it('never the step Claude is on, or one-line steps without times', () => {
    expect(inHead(step('run', 1, { status: 'running' }), 5)).toBe(false);
    expect(inHead(step('line-0', 1), 5)).toBe(false);
  });
});

describe('workingPhase', () => {
  const sub = (title: string, status: SubAgent['status'], kind: SubAgent['kind'] = 'agent'): SubAgent => ({ id: title, title, steps: [], status, kind });

  it('says what Claude is doing', () => {
    expect(workingPhase(turn('c', 1))).toBe('Starting');
    expect(workingPhase(turn('c', 1, { between: 'thinking', steps: ['Read src/a.ts'] }))).toBe('Thinking');
    // A step running says itself, in its row just above.
    expect(workingPhase(turn('c', 1, { steps: ['Bash npm test'] }))).toBe('');
    expect(workingPhase(turn('c', 1, { status: 'text', text: 'So far', between: 'writing' }))).toBe('Writing');
    expect(workingPhase(turn('c', 1, { status: 'text', text: 'Answered', subagents: [sub('npm run build', 'running', 'background')] }))).toBe('Waiting on 1 background task · npm run build');
  });

  it('before its first step, says what it waits on: an API retry, Claude Code downloading (BLG-403)', () => {
    expect(workingPhase(turn('c', 1, { progress: 'Claude is busy, retry 2 of 10' }))).toBe('Claude is busy, retry 2 of 10');
    expect(workingPhase(turn('c', 1, { progress: 'Getting Claude Code ready, one time: 40%' }))).toBe('Getting Claude Code ready, one time: 40%');
    // Once a step runs, the step says itself.
    expect(workingPhase(turn('c', 1, { progress: 'Claude is busy, retry 2 of 10', steps: ['Bash npm test'] }))).toBe('');
  });

  it('nothing when it isn’t at work, or waits for an approval', () => {
    expect(workingPhase(turn('c', 1, { status: 'done', text: 'ok' }))).toBeUndefined();
    expect(workingPhase(turn('c', 1, { status: 'awaiting_approval' }))).toBeUndefined();
    expect(workingPhase(turn('q', 1, { status: 'queued' }))).toBeUndefined();
  });
});

describe('subInHead', () => {
  const sub = (id: string, more: Partial<SubAgent> = {}): SubAgent => ({ id, title: id, steps: [], status: 'done', kind: 'background', startedAt: 1, ...more });

  it('keeps background work that had finished before the cut (BLG-45)', () => {
    expect(subInHead(sub('a', { endedAt: 3 }), 5)).toBe(true);
    expect(subInHead(sub('b', { endedAt: 8 }), 5)).toBe(false);
  });

  it('never one still running, or one whose end it can’t place', () => {
    expect(subInHead(sub('run', { status: 'running' }), 5)).toBe(false);
    expect(subInHead(sub('old'), 5)).toBe(false);
  });
});

describe('wordsOf', () => {
  const text = 'Before.\n\nAfter.';
  const marked = turn('c', 1, { text, textMarks: [{ at: 2, end: 7 }, { at: 8, end: text.length }] });

  it('gives a split turn’s head what it wrote before the cut, its tail the rest (BLG-45)', () => {
    expect(wordsOf(marked, { side: 'head', cut: 5 })).toBe('Before.');
    expect(wordsOf(marked, { side: 'tail', cut: 5 })).toBe('After.');
    expect(wordsOf(marked, { side: 'head', cut: 9 })).toBe(text);
    expect(wordsOf(marked, { side: 'tail', cut: 9 })).toBe('');
  });

  it('a whole card has all its words, a live part none', () => {
    expect(wordsOf(marked, undefined)).toBe(text);
    expect(wordsOf(marked, { side: 'live', cut: 1 })).toBe('');
  });

  it('words it can’t place in time are the tail’s', () => {
    expect(wordsOf(turn('c', 1, { text }), { side: 'head', cut: 9 })).toBe('');
    expect(wordsOf(turn('c', 1, { text }), { side: 'tail', cut: 9 })).toBe(text);
    expect(wordsOf(turn('c', 1, { text: 'Rewritten', textMarks: [{ at: 2, end: 7 }] }), { side: 'tail', cut: 9 })).toBe('Rewritten');
  });
});

describe('marksOf', () => {
  it('marks each stretch Claude writes with its time', () => {
    const first = marksOf('', undefined, 'One.', 2);
    expect(first).toEqual([{ at: 2, end: 4 }]);
    expect(marksOf('One.', first, 'One.\n\nTwo.', 5)).toEqual([{ at: 2, end: 4 }, { at: 5, end: 10 }]);
  });

  it('an answer that’s the end of what it said keeps that end’s marks', () => {
    const marks = [{ at: 2, end: 4 }, { at: 5, end: 10 }];
    expect(marksOf('One.\n\nTwo.', marks, 'Two.', undefined)).toEqual([{ at: 5, end: 4 }]);
    expect(marksOf('One.\n\nTwo.', marks, 'One.\n\nTwo.', undefined)).toBe(marks);
  });

  it('leaves words it can’t place unmarked', () => {
    expect(marksOf('One.', [{ at: 2, end: 4 }], 'Other words', undefined)).toBeUndefined();
    expect(marksOf('Old words', undefined, 'Old words\n\nNew.', 5)).toBeUndefined();
  });

  it('the store keeps them as Claude writes, and ends background work with a time', () => {
    const store = new Store(initialState('room', 'auto'));
    const ev = (event: 'started' | 'text' | 'sub' | 'done', text: string, ts: number) => store.dispatch({ type: 'agent_event', owner: 'me', requestId: 'r', requester: 'me', event, text, ts, channel: 'ws:1' });
    ev('started', '', 1);
    ev('text', 'Looking.', 2);
    ev('sub', JSON.stringify({ id: 'bg', phase: 'start', title: 'npm test', kind: 'background' }), 3);
    ev('sub', JSON.stringify({ id: 'bg', phase: 'done' }), 4);
    ev('text', 'Found it.', 6);
    ev('done', 'Found it.', 7);
    const card = store.getState().log.find((l): l is Agent => l.type === 'agent')!;
    expect(card.text).toBe('Found it.');
    expect(card.textMarks).toEqual([{ at: 6, end: 9 }]);
    expect(card.subagents[0]).toMatchObject({ status: 'done', endedAt: 4 });
  });
});
