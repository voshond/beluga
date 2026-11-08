import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Store, initialState } from '../src/core/store.js';
import { SENT_DIR, sentFolder } from '../src/shared/scratch-dir.js';
import { waitFor } from './helpers.js';

/** BLG-771: what you send your own agent reaches its scratch folder as it gets the message, and it's told where. */

const ME = 'me';
const TREE = 'ws:tree';
const CHAT = 'ws:chat';
const MAIN = 'ws:main';

function setup() {
  const store = new Store(initialState('room', 'auto'));
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-host-sent-')));
  const dir = path.join(base, 'ws');
  mkdirSync(dir);
  const file = path.join(base, 'mockup.pdf');
  writeFileSync(file, 'pdf');
  const runs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      return 'ok';
    },
  };
  const place = (channel: string) => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined, ...(channel === MAIN ? { askOnly: { project: 'api' } } : {}) });
  const kinds: Record<string, string> = { [TREE]: 'worktree', [CHAT]: 'chat', [MAIN]: 'main' };
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: { trustOf: () => 'full', isFriend: () => true } as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place, inChannel: (c: string) => ({ kind: kinds[c] }), refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
  });
  const ask = async (channel: string, prompt: string): Promise<AgentRunInput> => {
    const before = runs.length;
    await host.onAgentRequest(ME, { kind: 'agent_request', requestId: `${channel}-${before}`, prompt, viaAgent: false, channel, urgent: false, plan: false });
    await waitFor(() => runs.length > before);
    return runs.at(-1)!;
  };
  return { ask, dir, file };
}

describe('files you send your agent', () => {
  it('a worktree’s run gets a copy in sent/, and the words say where', async () => {
    const { ask, dir, file } = setup();
    const run = await ask(TREE, `match this\n\n\`${file}\``);
    expect(run.prompt).toContain(`\`${SENT_DIR}/mockup.pdf\``);
    expect(readFileSync(path.join(dir, SENT_DIR, 'mockup.pdf'), 'utf8')).toBe('pdf');
  });

  it('a chat sharing its folder keeps them in its own', async () => {
    const { ask, dir, file } = setup();
    const run = await ask(CHAT, `\`${file}\``);
    const rel = sentFolder(CHAT, false);
    expect(run.prompt).toContain(`${rel}/mockup.pdf`);
    expect(existsSync(path.join(dir, rel, 'mockup.pdf'))).toBe(true);
  });

  it('a main folder (read-only) gets nothing copied', async () => {
    const { ask, dir, file } = setup();
    const run = await ask(MAIN, `\`${file}\``);
    expect(run.prompt).not.toContain(SENT_DIR);
    expect(existsSync(path.join(dir, SENT_DIR))).toBe(false);
  });
});
