import { describe, expect, it } from 'vitest';
import type { AgentBackend } from '../src/agent/types.js';
import type { BtwRequest } from '../src/agent/btw.js';
import { btwPrompt } from '../src/agent/btw.js';
import { BtwDesk } from '../src/core/btw.js';
import { Store, initialState } from '../src/core/store.js';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function desk(btw: (req: BtwRequest) => Promise<string>, place = { cwd: '/tmp/wt', resume: 'sess-1', model: 'opus' }) {
  const store = new Store(initialState('room', 'auto'));
  const asked: BtwRequest[] = [];
  const agent = { run: async () => '', btw: (req: BtwRequest) => (asked.push(req), btw(req)) } as unknown as AgentBackend;
  const d = new BtwDesk({ store, agent: () => agent, place: (channel) => (channel === 'ws:a' ? place : undefined) });
  return { store, d, asked };
}

describe('side questions (/btw)', () => {
  it('forks the conversation and shows the answer beside it, never in the chat', async () => {
    const { store, d, asked } = desk(async (req) => {
      req.onText('Yes,');
      await tick(100);
      return 'Yes, the tests passed.';
    });
    const done = d.ask('ws:a', '  did the tests pass?  ');
    expect(store.getState().btw['ws:a']).toMatchObject({ question: 'did the tests pass?', state: 'thinking' });
    await done;
    expect(asked[0]).toMatchObject({ cwd: '/tmp/wt', resume: 'sess-1', model: 'opus', question: 'did the tests pass?' });
    expect(store.getState().btw['ws:a']).toMatchObject({ text: 'Yes, the tests passed.', state: 'done' });
    expect(store.getState().log.filter((l) => l.channel === 'ws:a')).toEqual([]);
  });

  it('streams what Claude has written so far', async () => {
    let finish: (v: string) => void = () => undefined;
    const { store, d } = desk((req) => {
      req.onText('Half');
      return new Promise((r) => (finish = r));
    });
    const done = d.ask('ws:a', 'q');
    await tick(150);
    expect(store.getState().btw['ws:a']).toMatchObject({ text: 'Half', state: 'answering' });
    finish('Half and whole');
    await done;
    expect(store.getState().btw['ws:a']?.state).toBe('done');
  });

  it('asking again replaces it; closing stops Claude and clears it', async () => {
    const { store, d, asked } = desk((req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('Stopped')))));
    const first = d.ask('ws:a', 'one');
    const second = d.ask('ws:a', 'two');
    await first;
    expect(asked[0]!.signal.aborted).toBe(true);
    expect(store.getState().btw['ws:a']).toMatchObject({ question: 'two', state: 'thinking' });
    d.dismiss('ws:a');
    await second;
    expect(asked[1]!.signal.aborted).toBe(true);
    expect(store.getState().btw['ws:a']).toBeUndefined();
  });

  it('says why when it fails, and refuses where there is no conversation to ask about', async () => {
    const { store, d } = desk(async () => {
      throw new Error('Claude couldn’t answer that');
    });
    await d.ask('ws:a', 'q');
    expect(store.getState().btw['ws:a']).toMatchObject({ state: 'failed', error: 'Claude couldn’t answer that' });
    await expect(d.ask('room', 'q')).rejects.toThrow(/worktree or project/);
  });

  it('an empty answer fails out loud instead of leaving a blank card (BLG-729)', async () => {
    const { store, d } = desk(async () => '  \n');
    await d.ask('ws:a', 'q');
    expect(store.getState().btw['ws:a']).toMatchObject({ state: 'failed', error: 'The answer came back empty' });
  });

  it('keeps what was streamed when the final answer is empty', async () => {
    const { store, d } = desk(async (req) => {
      req.onText('Streamed words');
      return '';
    });
    await d.ask('ws:a', 'q');
    expect(store.getState().btw['ws:a']).toMatchObject({ state: 'done', text: 'Streamed words' });
  });

  it('tells Claude it has no tools and nothing is kept', () => {
    const p = btwPrompt(' why? ');
    expect(p).toMatch(/side question/);
    expect(p).toMatch(/no tools/);
    expect(p.endsWith('why?')).toBe(true);
  });
});
