import { describe, expect, it } from 'vitest';
import { needsYou } from '../src/companion/needs-you.js';
import { NeedsYou } from '../src/companion/protocol.js';
import { runCard } from '../src/core/run-ask.js';
import { Store, initialState } from '../src/core/store.js';

const ME = 'me0000000000000000000000000000me';

const withCard = (why: string, on?: string) => {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: ME, isHost: true });
  const question = runCard(why, { ...(on ? { on } : {}), commands: ['sudo systemctl restart registry'], expect: 'active (running)' });
  if (typeof question === 'string') throw new Error(question);
  store.dispatch({ type: 'question_add', question: { qid: 'q1', requestId: 'r1', owner: ME, channel: 'ws:w1', picked: {}, question } });
  return needsYou(store.getState()).find((n) => n.id === 'question:q1')!;
};

describe('a run card on the phone (run_for_me)', () => {
  it('says where it runs, shows the commands, and lets you skip it or say what happened', () => {
    const need = NeedsYou.parse(withCard('The registry runs an old image.', 'nas'));
    expect(need.title).toBe('Run on nas: The registry runs an old image.');
    expect(need.detail).toBe('sudo systemctl restart registry');
    expect(need.choices).toEqual([]);
    expect(need.freeText).toBe(true);
    expect(need.actions).toEqual([{ label: 'Skip', tone: 'danger', method: 'questions.answer', args: ['q1', { kind: 'skip' }] }]);
  });

  it('runs here when no machine is named', () => {
    expect(withCard('Restart it.').title).toBe('Run this: Restart it.');
  });
});
