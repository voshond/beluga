import { describe, expect, it } from 'vitest';
import { createMockBackend } from '../src/agent/mock.js';
import type { AgentRunInput } from '../src/agent/types.js';

const input = (prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput => ({
  prompt,
  requesterName: 'kay',
  viaAgent: false,
  context: [],
  scope: 'full',
  signal: new AbortController().signal,
  place: { cwd: '/demo/wait', additionalDirectories: [], autoEdit: true, onSession: () => undefined },
  onEvent: () => undefined,
  onFileTouched: () => undefined,
  canUseTool: async () => true,
  ...extra,
});

describe('BLG-331: the demo agent waits on "keep working" only in a run with thread tools', () => {
  it('answers at once when the run has no thread tools', async () => {
    const agent = createMockBackend({} as never, 0.01);
    const answered = agent.run(input('please keep working'));
    const late = new Promise<'late'>((r) => setTimeout(() => r('late'), 3_000));
    expect(await Promise.race([answered.then(() => 'answered'), late])).toBe('answered');
  });

  it('works until stopped when the run has thread tools', async () => {
    const agent = createMockBackend({} as never, 0.01);
    const stop = new AbortController();
    const run = agent.run(input('please keep working', { signal: stop.signal, threadTools: {} as never }));
    const state = await Promise.race([run.then(() => 'ended', () => 'ended'), new Promise((r) => setTimeout(() => r('working'), 300))]);
    expect(state).toBe('working');
    stop.abort();
    await run.catch(() => undefined);
  });
});

describe('BLG-344: the demo agent stops on the usage limit in a child thread too', () => {
  it('a task whose last line is "usage limit" stops on the limit with a reset time', async () => {
    const agent = createMockBackend({} as never, 0.01);
    const run = agent.run(input('A task from the agent in the chat “lead”.\n\nusage limit', { threadTools: {} as never }));
    await expect(run).rejects.toMatchObject({ failure: { kind: 'usage_limit', resetsAt: expect.any(Number) } });
  });
});
