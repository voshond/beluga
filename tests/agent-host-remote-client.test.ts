import { describe, expect, it } from 'vitest';
import { buildRemoteClientAppend, runInstructions } from '../src/agent/run-instructions.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { runAsClient } from '../src/core/client-context.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

/** The computer's agent knows you are elsewhere (BLG-803): a run your app started from another computer is told so. */

const ME = 'me';

function host() {
  const inputs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input) {
      inputs.push(input);
      return 'ok';
    },
  };
  const h = new AgentHost({
    store: new Store(initialState('room', 'auto')),
    selfId: () => ME,
    send: (() => true) as never,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
  });
  const ask = (from: string, requestId: string): Promise<void> => h.onAgentRequest(from, { kind: 'agent_request', requestId, prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
  return { ask, inputs };
}

describe('a run started from your app on another computer', () => {
  it('has BELUGA_REMOTE_CLIENT in its env and the note in its instructions', async () => {
    const t = host();
    await runAsClient('machine:abc', () => t.ask(ME, 'r1'));
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.env?.BELUGA_REMOTE_CLIENT).toBe('1');
    // Tools that open a browser themselves (vite --open, create-react-app) don't, there (BLG-838).
    expect(t.inputs[0]?.env?.BROWSER).toBe('none');
    const said = runInstructions(t.inputs[0]!, 'Kayra');
    expect(said).toContain(buildRemoteClientAppend());
    expect(said).toContain('http://localhost:<port>');
    expect(said).toMatch(/Do not open browsers/);
  });

  it('a local run is unchanged: no env added, no note', async () => {
    const t = host();
    await runAsClient('0b9c-uuid-of-a-mac-screen', () => t.ask(ME, 'r1'));
    await t.ask(ME, 'r2');
    await waitFor(() => t.inputs.length === 2);
    for (const input of t.inputs) {
      expect(input.env).toBeUndefined();
      expect(runInstructions(input, 'Kayra')).not.toContain(buildRemoteClientAppend());
    }
  });

  it('a friend’s request is never marked, whoever relays it', async () => {
    const t = host();
    await runAsClient('machine:abc', () => t.ask('bob', 'r1'));
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.env?.BELUGA_REMOTE_CLIENT).toBeUndefined();
    expect(t.inputs[0]?.env?.BROWSER).toBeUndefined();
  });
});
