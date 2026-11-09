import { describe, expect, it } from 'vitest';
import type { Call } from '../packages/companion/lib/link/calls.js';
import { convAbilities, type ScopeStore, scoped } from '../packages/companion/lib/link/scoped.js';
import { SINCE } from '../src/companion/protocol.js';

/**
 * A conversation's screen on your Mac or on one of your computers (BLG-856): the helpers answer for
 * both without calling themselves (a Mac conversation once crashed the phone), and what only your
 * Mac does stays off a computer's.
 */

function fakeStore(): ScopeStore & { calls: Array<{ method: string; on?: string }>; asked: string[] } {
  const calls: Array<{ method: string; on?: string }> = [];
  const asked: string[] = [];
  return {
    calls,
    asked,
    supports: (w) => (asked.push(`mac:${w}`), SINCE[w] <= 46),
    supportsOn: (on, w) => (asked.push(`${on}:${w}`), w !== 'files'),
    call: async (c, opts) => (calls.push({ method: c.method, ...(opts?.on ? { on: opts.on } : {}) }), undefined),
  };
}

const call = (method: string): Call => ({ method, args: [], label: method }) as unknown as Call;
const conv = { topic: 'conv:ws:abc' as const, agent: { runtime: 'claude', label: 'Claude' }, mergeable: true, macTopic: false, askedTask: false };

describe('a conversation’s helpers, on your Mac or a computer', () => {
  it('answers for a Mac conversation with an agent set, asking the Mac', async () => {
    const store = fakeStore();
    const scope = scoped(store, undefined);
    const can = convAbilities(scope, conv);
    expect(can).toEqual({ hasFolder: true, branchMerge: true, agentPicker: true, merge: true, files: true, terminal: true, openOnMac: true, macChats: false, forget: false });
    expect(store.asked.every((a) => a.startsWith('mac:'))).toBe(true);
    await scope.call(call('host.stopRun'));
    expect(store.calls).toEqual([{ method: 'host.stopRun' }]);
    expect(scope.where).toEqual({});
  });

  it('answers for a computer’s conversation, asking that computer, without what only your Mac does', async () => {
    const store = fakeStore();
    const scope = scoped(store, 'mini');
    const can = convAbilities(scope, conv);
    expect(can).toMatchObject({ agentPicker: true, branchMerge: true, merge: false, files: false, terminal: false, openOnMac: false, macChats: false });
    expect(store.asked.every((a) => a.startsWith('mini:'))).toBe(true);
    await scope.call(call('host.stopRun'), { queue: false });
    expect(store.calls).toEqual([{ method: 'host.stopRun', on: 'mini' }]);
    expect(scope.where).toEqual({ on: 'mini' });
  });

  it('answers before the conversation has come, and for Your Mac’s chats and a request to a friend', () => {
    const scope = scoped(fakeStore(), undefined);
    expect(convAbilities(scope, undefined)).toMatchObject({ hasFolder: false, agentPicker: false, merge: false });
    expect(convAbilities(scope, { topic: 'conv:mac:assistant', macTopic: true, askedTask: false }).macChats).toBe(true);
    expect(convAbilities(scope, { topic: 'conv:task:t1', macTopic: false, askedTask: true }).forget).toBe(true);
  });
});
