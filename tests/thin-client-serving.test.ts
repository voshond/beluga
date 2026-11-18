import { describe, expect, it } from 'vitest';
import { buildServedAppend } from '../src/agent/prompt.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import type { Session } from '../src/core/session.js';
import { Store, initialState } from '../src/core/store.js';
import { PREVIEW_HANDLERS } from '../src/ipc/preview-handlers.js';
import { appContextsOf } from '../src/mcp-apps/contexts.js';
import { attachLanServing, lanAddress, lanHost, servedLan } from '../src/net/lan.js';
import { type ProcRow, keptAlive } from '../src/workspaces/test-procs.js';
import { waitFor } from './helpers.js';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` });

describe('this computer on the local network', () => {
  it('is its LAN address, never a container’s, a VPN’s or loopback', () => {
    const ifaces = { lo: [v4('127.0.0.1', true)], docker0: [v4('172.17.0.1')], 'br-970810c1ed79': [v4('172.18.0.1')], tailscale0: [v4('100.64.0.2')], enp125s0u2: [v4('192.168.2.50')] };
    expect(lanAddress(ifaces)).toBe('192.168.2.50');
    expect(lanAddress({ lo: [v4('127.0.0.1', true)], docker0: [v4('172.17.0.1')] })).toBeUndefined();
    expect(lanHost({}, ifaces)).toEqual({ host: '192.168.2.50', ip: '192.168.2.50' });
    expect(lanHost({ BELUGA_LAN_HOST: 'i9arch' }, ifaces)).toEqual({ host: 'i9arch', ip: '192.168.2.50' });
    expect(lanHost({ BELUGA_LAN_HOST: 'bad host/' }, ifaces)?.host).toBe('192.168.2.50');
  });

  it('is offered only while the daemon says its web port serves the network', () => {
    const session = {};
    expect(servedLan(session)).toBeUndefined();
    let serving = false;
    attachLanServing(session, () => serving);
    expect(servedLan(session)).toBeUndefined();
    serving = true;
    expect(servedLan(session) === undefined).toBe(lanAddress() === undefined);
  });
});

function host(servedTo?: string) {
  const inputs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input) {
      inputs.push(input);
      return 'ok';
    },
  };
  const h = new AgentHost({
    store: new Store(initialState('room', 'auto')),
    selfId: () => 'me',
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
    servedTo: () => servedTo,
  });
  const ask = (from: string): Promise<void> => h.onAgentRequest(from, { kind: 'agent_request', requestId: `r-${Math.random()}`, prompt: 'start the dev server', viaAgent: false, channel: 'room', urgent: false, plan: false });
  return { ask, inputs };
}

describe('your agent on a computer that serves others', () => {
  it('is told the user is elsewhere, and to start servers they can reach', async () => {
    const t = host('i9arch');
    await t.ask('me');
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.servedTo).toBe('i9arch');
    const said = runInstructions(t.inputs[0]!, 'Kay');
    expect(said).toContain(buildServedAppend('i9arch').trim());
    expect(said).toContain('http://i9arch:<port>');
  });

  it('is told nothing of it when nothing serves the network, or for a friend’s ask', async () => {
    const off = host(undefined);
    await off.ask('me');
    await waitFor(() => off.inputs.length === 1);
    expect(runInstructions(off.inputs[0]!, 'Kay')).not.toContain('serves Beluga to other computers');
    const friend = host('i9arch');
    await friend.ask('friend');
    await waitFor(() => friend.inputs.length === 1);
    expect(friend.inputs[0]?.servedTo).toBeUndefined();
  });

  it('leaves it to the remote-client note when your app drives this computer', async () => {
    const t = host('i9arch');
    await t.ask('me');
    await waitFor(() => t.inputs.length === 1);
    const driven: AgentRunInput = { ...t.inputs[0]!, env: { BELUGA_REMOTE_CLIENT: '1' } };
    expect(runInstructions(driven, 'Kay')).not.toContain('serves Beluga to other computers');
  });
});

describe('what a run kept running', () => {
  const W = '/work/tree';
  const row = (pid: number, line: string): ProcRow => ({ pid, ppid: 1, line });

  it('counts only what still runs there, not the shell it was started from', () => {
    expect(keptAlive([row(10, `node vite --host BELUGA_KEEP=1 BELUGA_WORKTREE=${W}`)], W)).toBe(true);
    expect(keptAlive([row(10, `node vite BELUGA_WORKTREE=${W}`)], W)).toBe(false);
    expect(keptAlive([row(10, `node vite BELUGA_KEEP=1 BELUGA_WORKTREE=/other`)], W)).toBe(false);
    expect(keptAlive([row(10, `/bin/zsh -c source /home/me/.claude/shell-snapshots/snapshot-zsh-1.sh BELUGA_KEEP=1 BELUGA_WORKTREE=${W}`)], W)).toBe(false);
  });
});

describe('a preview that failed while drawing', () => {
  const session = (experiments: string[], folder?: string) => ({ store: { getState: () => ({ prefs: { experiments } }) }, workbench: { folderOf: () => folder } }) as unknown as Session;

  it('reaches your agent with its next turn in that worktree, once', () => {
    const s = session(['previews'], '/work/tree');
    expect(PREVIEW_HANDLERS['preview.failed'](s, 'w1', { title: 'Selection.tsx', problem: 'Selection stopped while drawing', details: 'TypeError: import_meta.glob is not a function' })).toEqual({ ok: true });
    const told = appContextsOf(s).take('ws:w1');
    expect(told).toHaveLength(1);
    expect(told[0]?.app).toBe('beluga-preview · Selection.tsx');
    expect(told[0]?.text).toContain("didn't draw for the user: Selection stopped while drawing.");
    expect(told[0]?.text).toContain('import_meta.glob');
    expect(appContextsOf(s).take('ws:w1')).toEqual([]);
    expect(PREVIEW_HANDLERS['preview.failed'](session([], '/work/tree'), 'w1', { title: 'A', problem: 'B' })).toEqual({ ok: false });
    expect(PREVIEW_HANDLERS['preview.failed'](session(['previews']), 'w1', { title: 'A', problem: 'B' })).toEqual({ ok: false });
  });
});
