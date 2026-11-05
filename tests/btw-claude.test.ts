import { describe, expect, it, vi } from 'vitest';
import type { BtwRequest } from '../src/agent/btw.js';

// Claude Code for askBtw: yields what each test scripts.
const claude: { messages: object[] } = { messages: [] };
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: () =>
    (async function* () {
      yield* claude.messages;
    })(),
}));
const { askBtw, emptyAnswer } = await import('../src/agent/runtime/claude/btw.js');

const req = (): BtwRequest => ({ question: 'q', cwd: '/tmp/wt', signal: new AbortController().signal, onText: () => undefined });
const assistant = (...content: object[]) => ({ type: 'assistant', message: { content } });
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const success = (result: string, stop = 'end_turn') => ({ type: 'result', subtype: 'success', result, stop_reason: stop });

describe('a side question on Claude Code (/btw)', () => {
  it('answers with the result, else what was streamed', async () => {
    claude.messages = [delta('Stre'), delta('amed'), assistant({ type: 'text', text: 'Streamed' }), success('The result')];
    expect(await askBtw(req())).toBe('The result');
    claude.messages = [delta('Streamed'), success('')];
    expect(await askBtw(req())).toBe('Streamed');
  });

  it("falls back to the words in Claude's reply when the stream and the result are empty (BLG-729)", async () => {
    claude.messages = [assistant({ type: 'thinking', thinking: '' }, { type: 'text', text: 'From the reply' }), success('')];
    expect(await askBtw(req())).toBe('From the reply');
  });

  it('an answer with no words is an error that says what came back (BLG-729)', async () => {
    claude.messages = [assistant({ type: 'thinking', thinking: '' }), success('', 'end_turn')];
    await expect(askBtw(req())).rejects.toThrow('Claude finished without an answer (it sent only thinking, stop: end_turn)');
    expect(emptyAnswer([])).toBe('Claude finished without an answer (it sent nothing)');
  });
});
