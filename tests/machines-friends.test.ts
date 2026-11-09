import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Intent } from '../src/core/intents.js';
import { NO_NETWORK, reduceNetwork } from '../src/core/network-store.js';
import type { Action, Approval, DomainState } from '../src/core/store.js';
import { FriendsLink, attachFriendsLink, routeToAlwaysOn } from '../src/machines/friends.js';
import type { MachineRecord } from '../src/machines/book.js';
import type { MessageView, NetworkState } from '../src/net/mesh/views.js';
import type { MessageSocket } from '../src/net/transport.js';

/** Friends through your Always On (BLG-797): its network shown here, its friends' requests answered here, calls forwarded. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-friends-'));
  dirs.push(d);
  return d;
};
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Waits until `ok` holds (a slow CI runner takes longer than a fixed tick), up to two seconds. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await tick();
}

class End extends EventEmitter implements MessageSocket {
  peer!: End;
  isOpen = true;
  send(data: string): void {
    if (this.isOpen) setImmediate(() => this.peer.isOpen && this.peer.emit('message', data));
  }
  close(code = 1000): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.peer.isOpen = false;
    setImmediate(() => {
      this.emit('close', code);
      this.peer.emit('close', code);
    });
  }
  terminate(): void {
    this.close(1006);
  }
  ping(): void {}
}

const msg = (id: string, text: string, conversation = 'dm:mia'): MessageView => ({ id, conversation, from: 'mia', name: 'mia', text, ts: Date.now(), mine: false }) as unknown as MessageView;
const network = (messages: Record<string, MessageView[]> = {}): NetworkState => ({ ...NO_NETWORK, enabled: true, self: { peerId: 'me', name: 'kayra', presence: { state: 'online' }, appearOffline: false } as never, friends: [{ peerId: 'mia', name: 'mia' } as never], messages });
const approval = (id: string): Approval => ({ id, kind: 'request', title: 'mia wants to run npm test', detail: 'in landing', peer: 'mia' });

/** Your Always On's daemon, as much as the link sees of it: hello → welcome, calls answered, frames pushed. */
class AlwaysOnDaemon {
  ends: End[] = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  attention: unknown[] = [];
  state: Pick<DomainState, 'network' | 'approvals'> = { network: network({ 'dm:mia': [msg('m1', 'hi')] }), approvals: [approval('a1'), { id: 'mine', kind: 'tool', title: 'your Claude', detail: '' }] };
  answer: (method: string, args: unknown[]) => unknown = () => 'ok';
  open(): Promise<MessageSocket> {
    const here = new End();
    const there = new End();
    here.peer = there;
    there.peer = here;
    this.ends.push(there);
    there.on('message', (text: string) => {
      const f = JSON.parse(text) as { t: string; id?: string; method?: string; args?: unknown[]; attention?: unknown };
      if (f.t === 'hello') there.send(JSON.stringify({ t: 'welcome', clientId: 'c1', version: 'x', ipc: 1, snapshot: this.state, seq: 1, clients: 1 }));
      if (f.t === 'attention') this.attention.push(f.attention);
      if (f.t === 'call') {
        this.calls.push({ method: f.method!, args: f.args! });
        there.send(JSON.stringify({ t: 'result', id: f.id, ok: true, value: this.answer(f.method!, f.args!) }));
      }
    });
    return Promise.resolve(here);
  }
  push(frame: unknown): void {
    for (const e of this.ends) if (e.isOpen) e.send(JSON.stringify(frame));
  }
}

/** This Mac's daemon: a store with the network, approvals and attention, its intents and a FriendsLink. */
function mac(daemon: AlwaysOnDaemon, opts: { file?: string; at?: () => string | undefined } = {}) {
  let state = { network: NO_NETWORK, approvals: [] as readonly Approval[], attention: { shown: [] as string[], visible: [] as string[], files: false, front: true } } as unknown as DomainState;
  const actions: Action[] = [];
  const listeners = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    dispatch: (a: Action) => {
      actions.push(a);
      if (a.type.startsWith('net_')) state = { ...state, ...reduceNetwork(state, a as never) };
      if (a.type === 'approval_add') state = { ...state, approvals: [...state.approvals, a.approval] };
      if (a.type === 'approval_remove') state = { ...state, approvals: state.approvals.filter((x) => x.id !== a.id) };
      for (const l of [...listeners]) l();
    },
    setAttention: (shown: string[]) => {
      state = { ...state, attention: { ...state.attention, shown } };
      for (const l of [...listeners]) l();
    },
  };
  const intents: Array<{ intent: Intent; to: string | undefined }> = [];
  const record = { cert: { device: 'a'.repeat(64) }, name: 'Mac mini' } as unknown as MachineRecord;
  let at: string | undefined = 'aaaaaaaaaaaaaaaa';
  const link = new FriendsLink({
    machines: { book: { get: (id) => (id === 'aaaaaaaaaaaaaaaa' ? record : undefined) }, drives: () => true, openLink: () => daemon.open() },
    at: opts.at ?? (() => at),
    store,
    intents: { emit: (intent, to) => void intents.push({ intent, to }) },
    version: '9.9.9',
    ...(opts.file ? { file: opts.file } : {}),
    backoffMs: [5],
    checkMs: 60_000,
  });
  const session = { store };
  attachFriendsLink(session, link);
  return { link, store, actions, intents, session, moveBack: () => ((at = undefined), link.check()) };
}

describe('your network through your Always On', () => {
  it('shows its friends, chats and new messages here, as they happen', async () => {
    const daemon = new AlwaysOnDaemon();
    const m = mac(daemon);
    m.link.start();
    await until(() => m.link.live);
    expect(m.link.live).toBe(true);
    expect(m.store.getState().network.enabled).toBe(true);
    expect(m.store.getState().network.messages['dm:mia']?.map((x) => x.text)).toEqual(['hi']);
    daemon.push({ t: 'action', seq: 2, action: { type: 'net_message', message: msg('m2', 'are you there?') } });
    await until(() => m.store.getState().network.messages['dm:mia']?.length === 2);
    expect(m.store.getState().network.messages['dm:mia']?.map((x) => x.text)).toEqual(['hi', 'are you there?']);
    // Its network stopping isn't this Mac's: what's shown stays.
    daemon.push({ t: 'action', seq: 3, action: { type: 'net_off' } });
    await tick(20);
    expect(m.store.getState().network.enabled).toBe(true);
    m.link.stop();
  });

  it('a message that came while this Mac was closed is waiting, and is news against what it showed last', async () => {
    const file = path.join(tmp(), 'friends-mirror.json');
    const first = new AlwaysOnDaemon();
    const before = mac(first, { file });
    before.link.start();
    await until(() => before.link.live);
    before.link.stop();

    // Closed: mia wrote twice meanwhile.
    const later = new AlwaysOnDaemon();
    later.state = { ...later.state, network: network({ 'dm:mia': [msg('m1', 'hi'), msg('m2', 'still there?'), msg('m3', 'call me')] }) };
    const after = mac(later, { file });
    after.link.start();
    // What it showed last comes first (no news yet), then the Always On's now.
    const mirrors = after.actions.filter((a) => a.type === 'net_mirror') as Array<Extract<Action, { type: 'net_mirror' }>>;
    expect(mirrors[0]?.network.messages['dm:mia']?.map((x) => x.id)).toEqual(['m1']);
    await until(() => after.link.live);
    expect(after.store.getState().network.messages['dm:mia']?.map((x) => x.id)).toEqual(['m1', 'm2', 'm3']);
    after.link.stop();
  });

  it('a friend’s request waits here too, and your answer from here is the one it gets', async () => {
    const daemon = new AlwaysOnDaemon();
    const m = mac(daemon);
    m.link.start();
    await until(() => m.link.live);
    // Only friends' requests: your own Claude's tool approvals there stay there.
    expect(m.store.getState().approvals.map((a) => a.id)).toEqual(['ao:a1']);
    const answered = await routeToAlwaysOn(m.session, 'host.answerApproval', ['yes', 'ao:a1'], 'screen-1');
    expect(answered).toEqual({ ok: true, value: 'ok' });
    expect(daemon.calls).toEqual([{ method: 'host.answerApproval', args: ['yes', 'a1'] }]);
    // Answered on the phone or there first: it goes from here too.
    daemon.push({ t: 'action', seq: 2, action: { type: 'approval_remove', id: 'a1' } });
    await until(() => m.store.getState().approvals.length === 0);
    expect(m.store.getState().approvals).toEqual([]);
    // A new one while you look.
    daemon.push({ t: 'action', seq: 3, action: { type: 'approval_add', approval: approval('a2') } });
    await until(() => m.store.getState().approvals.length === 1);
    expect(m.store.getState().approvals.map((a) => a.id)).toEqual(['ao:a2']);
    // This Mac's own approvals stay here.
    expect(routeToAlwaysOn(m.session, 'host.answerApproval', ['yes', 'local-1'], 'screen-1')).toBeUndefined();
    m.link.stop();
  });

  it('sends what you write there, says what your screens show, and hands call signals to the screen in the call', async () => {
    const daemon = new AlwaysOnDaemon();
    const m = mac(daemon);
    m.link.start();
    await until(() => m.link.live);
    expect(await routeToAlwaysOn(m.session, 'network.dm.send', ['mia', 'on my way'], 'screen-1')).toEqual({ ok: true, value: 'ok' });
    expect(routeToAlwaysOn(m.session, 'workspaces.list', [], 'screen-1')).toBeUndefined();
    m.store.setAttention(['dm:mia']);
    await until(() => JSON.stringify(daemon.attention.at(-1) ?? null).includes('dm:mia'));
    expect(daemon.attention.at(-1)).toMatchObject({ shown: ['dm:mia'] });
    await routeToAlwaysOn(m.session, 'calls.join', ['dm:mia'], 'screen-2');
    daemon.push({ t: 'intent', intent: { type: 'call_signal', conversation: 'dm:mia', call: 'c', from: 'mia', data: 'sdp' } });
    daemon.push({ t: 'intent', intent: { type: 'navigate', view: { kind: 'home' } } });
    await until(() => m.intents.length > 0);
    await tick(20);
    expect(m.intents).toEqual([{ intent: { type: 'call_signal', conversation: 'dm:mia', call: 'c', from: 'mia', data: 'sdp' }, to: 'screen-2' }]);
    m.link.stop();
  });

  it('says plainly when your Always On can’t be reached, and stops routing once you moved back here', async () => {
    const daemon = new AlwaysOnDaemon();
    const m = mac(daemon);
    m.link.start();
    await until(() => m.link.live);
    daemon.ends[0]!.close();
    await until(() => !m.link.live);
    expect(await routeToAlwaysOn(m.session, 'network.dm.send', ['mia', 'x'], 's')).toMatchObject({ ok: false, error: expect.stringMatching(/can’t be reached right now/) });
    // It comes back by itself.
    await until(() => m.link.live);
    expect(m.link.live).toBe(true);
    m.moveBack();
    expect(m.link.routing).toBe(false);
    expect(routeToAlwaysOn(m.session, 'network.dm.send', ['mia', 'x'], 's')).toBeUndefined();
    expect(m.store.getState().approvals).toEqual([]);
    m.link.stop();
  });
});
