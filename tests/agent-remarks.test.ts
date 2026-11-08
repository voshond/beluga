import { describe, expect, it } from 'vitest';
import { type Action, type LogItem, initialState, reduceDomain } from '../src/core/store.js';
import { READS_AFTER_STEP } from '../src/shared/claude-notices.js';

/** What Claude says between its steps is kept apart from its answer (the words after its last step). */

type AgentItem = Extract<LogItem, { type: 'agent' }>;

const ev = (event: string, text: string, ts: number): Action => ({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event, text, ts, channel: 'ws:w1' }) as Action;
const card = (actions: readonly Action[]): AgentItem => actions.reduce(reduceDomain, initialState('room')).log.find((l): l is AgentItem => l.type === 'agent')!;

describe('agent remarks', () => {
  it('moves words to remarks once a step follows them, and keeps only the words after the last step as the answer', () => {
    const c = card([ev('started', '', 1), ev('text', 'Let me look.', 2), ev('tool', 'Read a.ts', 3), ev('text', 'Found it.', 4), ev('text', 'Now the tests.', 5), ev('tool', 'Bash npm test', 6), ev('text', 'All green.', 7)]);
    expect(c.remarks).toEqual([
      { text: 'Let me look.', ts: 2 },
      { text: 'Found it.\n\nNow the tests.', ts: 4 },
    ]);
    expect(c.text).toBe('All green.');
  });

  it('a step right after a step makes no remark', () => {
    const c = card([ev('started', '', 1), ev('tool', 'Read a.ts', 2), ev('tool', 'Read b.ts', 3), ev('text', 'Done.', 4)]);
    expect(c.remarks).toBeUndefined();
    expect(c.text).toBe('Done.');
  });

  it('a sub-agent starting is a step too', () => {
    const c = card([ev('started', '', 1), ev('text', 'Sending a helper.', 2), ev('sub', JSON.stringify({ id: 's1', phase: 'start', title: 'Explore' }), 3)]);
    expect(c.remarks).toEqual([{ text: 'Sending a helper.', ts: 2 }]);
    expect(c.text).toBe('');
    const moved = card([ev('started', '', 1), ev('text', 'Waiting on it.', 2), ev('sub', JSON.stringify({ id: 's1', phase: 'start', title: 'Explore' }), 3), ev('text', 'Still on it.', 4), ev('sub', JSON.stringify({ id: 's1', phase: 'step', step: 'Read x' }), 5)]);
    expect(moved.text).toBe('Still on it.');
  });

  it('the answer the run ends with replaces the words since its last step, remarks stay', () => {
    const c = card([ev('started', '', 1), ev('text', 'Checking.', 2), ev('tool', 'Read a.ts', 3), ev('text', 'It works.', 4), ev('done', 'It works.', 5)]);
    expect(c.text).toBe('It works.');
    expect(c.remarks).toEqual([{ text: 'Checking.', ts: 2 }]);
  });

  it('a steered message’s note is never a remark', () => {
    const c = card([ev('started', '', 1), ev('text', READS_AFTER_STEP, 2)]);
    const after = [ev('started', '', 1), ev('done', READS_AFTER_STEP, 2), ev('tool', 'Read a.ts', 3)].reduce(reduceDomain, initialState('room')).log.find((l): l is AgentItem => l.type === 'agent')!;
    expect(c.remarks).toBeUndefined();
    expect(after.remarks).toBeUndefined();
  });
});
