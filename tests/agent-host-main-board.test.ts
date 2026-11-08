import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import { AgentHost } from '../src/core/agent-host.js';
import type { Plan } from '../src/core/plans/model.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

/**
 * BLG-626: a project's main folder is read-only for files, but its chat may still write to the
 * task board (Beluga's own state, not a file there). A plan's own conversation may too. Syncing
 * main and a milestone's checker stay without it; a friend's run never gets it.
 */

const ME = 'me';
const MAIN = 'ws:main';
const SYNC = 'ws:sync';
const HOME = 'ws:home';
const CHECKER = 'ws:checker';
const TREE = 'ws:tree';

function setup() {
  const store = new Store(initialState('room', 'auto'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-main-board-'));
  store.dispatch({ type: 'plans_init', state: { enabled: true, style: '', plans: [{ id: 'pl1', projectId: 'p', home: HOME, status: 'active', runs: {}, activity: [] } as unknown as Plan] } });
  const runs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      return 'ok';
    },
  };
  const place = (channel: string) => ({
    cwd: dir,
    additionalDirectories: [],
    autoEdit: channel === TREE,
    onSession: () => undefined,
    ...(channel === TREE ? {} : { askOnly: { project: 'api' } }),
    ...(channel === SYNC ? { syncMain: { branch: 'main', upstream: 'origin/main' } } : {}),
  });
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    board: (channel, from) => (from === ME ? { tools: { channel } as never, brief: `board for ${channel}` } : undefined),
    plans: (channel) => (channel === HOME ? { tools: {} as never, brief: 'head' } : channel === CHECKER ? { tools: {} as never, brief: 'check', checker: true } : undefined),
  });
  const ask = async (channel: string, from = ME): Promise<AgentRunInput> => {
    const before = runs.length;
    await host.onAgentRequest(from, { kind: 'agent_request', requestId: `${channel}-${from}`, prompt: 'make a task', viaAgent: false, channel, urgent: false, plan: false });
    await waitFor(() => runs.length > before);
    return runs.at(-1)!;
  };
  return { ask };
}

describe('the task board in a main folder’s chat', () => {
  it('your own run there gets the board’s tools and brief', async () => {
    const run = await setup().ask(MAIN);
    expect(run.place?.askOnly).toBeTruthy();
    expect(run.board).toBeDefined();
    expect(run.taskBrief).toBe(`board for ${MAIN}`);
    // …and is told board work stays here, while code changes still move to a worktree.
    expect(runInstructions(run, 'Kay')).toContain('never needs a worktree');
  });

  it('a worktree’s run still gets it', async () => {
    expect((await setup().ask(TREE)).board).toBeDefined();
  });

  it('a plan’s own conversation gets it, beside the plan’s tools', async () => {
    const run = await setup().ask(HOME);
    expect(run.board).toBeDefined();
    expect(run.planTools).toBeDefined();
    expect(run.planTask).toBeUndefined();
  });

  it('not while syncing main, nor in a milestone’s checker', async () => {
    const t = setup();
    expect((await t.ask(SYNC)).board).toBeUndefined();
    const check = await t.ask(CHECKER);
    expect(check.board).toBeUndefined();
    expect(check.planTools).toBeDefined();
  });
});
